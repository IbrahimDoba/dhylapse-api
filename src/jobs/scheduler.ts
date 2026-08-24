import { sql as raw } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client.ts';
import { deliverQueuedEmails } from './deliver-notifications.ts';
import { runExpiryScan } from './expiry-scan.ts';

/**
 * Runs the expiry scan on a schedule.
 *
 * Deliberately small: a Postgres advisory lock plus a timer, rather than a job
 * queue. The scan is idempotent by construction — alert_event is unique per
 * (rule, batch) — so the hard problems a queue solves (exactly-once delivery,
 * retry semantics) are already handled by the schema. What is left is "run it
 * roughly daily, and not twice at once", which is what this does.
 *
 * The advisory lock is the part that matters. Two app instances behind a load
 * balancer would otherwise both scan every night; the lock makes exactly one
 * of them win, and a crash releases it automatically because it is tied to the
 * session rather than to a row.
 *
 * When throughput or retry policy outgrows this, pg-boss slots in behind the
 * same runExpiryScan() call.
 */

/** Arbitrary but fixed — any other advisory lock in the app must not reuse it. */
const SCAN_LOCK_KEY = 4_812_355;
const DELIVERY_LOCK_KEY = 4_812_356;

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

export interface SchedulerHandle {
  stop: () => void;
}

async function attemptScan(app: FastifyInstance): Promise<void> {
  const [lock] = await db.execute<{ acquired: boolean }>(
    raw`SELECT pg_try_advisory_lock(${SCAN_LOCK_KEY}) AS acquired`,
  );
  if (!lock?.acquired) {
    app.log.debug('expiry scan already running on another instance');
    return;
  }

  try {
    // Skip if a scan already succeeded today; a restart should not re-run it.
    const [recent] = await db.execute<{ ran: boolean }>(raw`
      SELECT EXISTS (
        SELECT 1 FROM job_run
         WHERE job_name = 'expiry_scan'
           AND status = 'succeeded'
           AND started_at > now() - interval '20 hours'
      ) AS ran`);
    if (recent?.ran) {
      app.log.debug('expiry scan already completed within the last 20 hours');
      return;
    }

    app.log.info('running scheduled expiry scan');
    const result = await runExpiryScan();
    app.log[result.organizationsFailed > 0 ? 'error' : 'info'](
      {
        organizations: result.organizationsScanned,
        failed: result.organizationsFailed,
        alerts: result.alertsCreated,
        notifications: result.notificationsQueued,
      },
      'expiry scan finished',
    );
  } catch (err) {
    app.log.error({ err }, 'scheduled expiry scan threw');
  } finally {
    await db.execute(raw`SELECT pg_advisory_unlock(${SCAN_LOCK_KEY})`);
  }
}

/**
 * Drains the email queue.
 *
 * Runs far more often than the scan: the scan produces work once a day, but a
 * retry after a provider blip should go out in minutes, not tomorrow. Its own
 * lock, so a long scan never blocks delivery.
 */
async function attemptDelivery(app: FastifyInstance): Promise<void> {
  const [lock] = await db.execute<{ acquired: boolean }>(
    raw`SELECT pg_try_advisory_lock(${DELIVERY_LOCK_KEY}) AS acquired`,
  );
  if (!lock?.acquired) return;

  try {
    const result = await deliverQueuedEmails();
    if (result.attempted > 0) {
      app.log.info(result, 'notification delivery finished');
    }
  } catch (err) {
    app.log.error({ err }, 'notification delivery threw');
  } finally {
    await db.execute(raw`SELECT pg_advisory_unlock(${DELIVERY_LOCK_KEY})`);
  }
}

export function startScheduler(app: FastifyInstance): SchedulerHandle {
  // Checked hourly rather than fired once a day: a process that restarts at
  // 03:05 would otherwise miss a 03:00 slot entirely, and the 20-hour guard
  // above already prevents a second run the same day.
  const timer = setInterval(() => void attemptScan(app), HOUR);
  timer.unref();

  const deliveryTimer = setInterval(() => void attemptDelivery(app), 2 * MINUTE);
  deliveryTimer.unref();

  // A short delay on boot keeps startup fast and avoids every instance in a
  // rolling deploy contending for the lock at the same instant.
  const initial = setTimeout(() => void attemptScan(app), 30_000);
  initial.unref();

  app.log.info(
    'scheduler started — expiry scan hourly (at most once per day), email delivery every 2 minutes',
  );

  return {
    stop: () => {
      clearInterval(timer);
      clearInterval(deliveryTimer);
      clearTimeout(initial);
    },
  };
}
