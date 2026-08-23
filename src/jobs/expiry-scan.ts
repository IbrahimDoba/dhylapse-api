import { sql as raw } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { withTenant, type TenantTx } from '../db/tenant.ts';

/**
 * The nightly expiry scan.
 *
 * For every organization, finds batches that have crossed an alert threshold
 * and raises one alert_event per (rule, batch) — exactly once, ever. The unique
 * index on (alert_rule_id, batch_id) is what guarantees that, so a crash
 * mid-run, a retry, or two workers racing all converge on the same result
 * rather than double-alerting.
 *
 * Runs inside withTenant per organization, so RLS is active throughout. The
 * only cross-tenant step is enumerating organizations, which goes through a
 * SECURITY DEFINER function that returns nothing else.
 */

export interface ScanResult {
  organizationsScanned: number;
  /** Organizations that failed. A scan with errors is NOT a successful scan. */
  organizationsFailed: number;
  alertsCreated: number;
  notificationsQueued: number;
  errors: { organizationId: string; message: string }[];
}

interface OrgRow extends Record<string, unknown> { id: string; name: string; timezone: string }

/**
 * Raises alert events for one tenant and returns the ids it created.
 *
 * Two selections happen here, and both exist to suppress noise.
 *
 * SCOPE — most-specific-wins. If a product has its own rules they replace the
 * organization ladder for that product rather than adding to it, so a custom
 * 60-day rule on insulin does not also deliver the default 90-day alert.
 *
 * BAND — one threshold per batch per scan, the narrowest the batch currently
 * sits inside. The ladder escalates over time: a lot warns at 180 days, again
 * at 90, again at 30, urgently at 7 — four alerts across its life, not four in
 * one night. Firing every threshold whose window the batch has passed means a
 * lot received with 5 days left arrives as 180/90/30/7 simultaneously, which
 * is the exact fatigue the ladder is meant to prevent.
 *
 * Because alert_event is unique per (rule, batch), each rung fires at most
 * once ever, and a scan that missed days still catches the right rung when it
 * next runs.
 */
async function scanOrganization(
  tx: TenantTx,
  organizationId: string,
  currency: string,
): Promise<string[]> {
  /*
   * Rules are read first and the scan runs one INSERT per rung, because the
   * obvious query — join every rule to every batch, then pick a winner with
   * DISTINCT ON — is quadratic and unindexable. At 200k batches it ran for
   * over twenty minutes without inserting a row.
   *
   * Sorting the thresholds turns each rung into a half-open range:
   *
   *   7d rule   ->                      eed <= today+7
   *   30d rule  ->  today+7  < eed  and eed <= today+30
   *   90d rule  ->  today+30 < eed  and eed <= today+90
   *   180d rule ->  today+90 < eed  and eed <= today+180
   *
   * Each is a plain range scan on batch_expiry_scan_idx, and "narrowest band
   * wins" falls out of the ranges themselves rather than needing a sort.
   */
  const rules = await tx.execute<{
    id: string; threshold_days: number; severity: number;
    product_id: string | null; category_id: string | null; location_id: string | null;
  }>(raw`
    SELECT id, threshold_days, severity, product_id, category_id, location_id
      FROM alert_rule
     WHERE kind = 'expiry' AND is_enabled AND deleted_at IS NULL
       AND threshold_days IS NOT NULL
     ORDER BY threshold_days ASC`);

  const created: string[] = [];
  let lowerBound: number | null = null;

  for (const rule of rules) {
    const inserted = await tx.execute<{ id: string }>(raw`
      INSERT INTO alert_event (
        organization_id, location_id, alert_rule_id, batch_id, product_id,
        kind, threshold_days, severity, days_remaining,
        quantity_at_alert, value_at_risk_minor, currency
      )
      SELECT ${organizationId}, b.location_id, ${rule.id}, b.id, b.product_id,
             'expiry', ${rule.threshold_days}::int, ${rule.severity}::smallint,
             (b.effective_expiry_date - CURRENT_DATE)::int,
             b.quantity_on_hand,
             b.unit_cost_minor * b.quantity_on_hand,
             ${currency}
        FROM batch b
        JOIN product p ON p.id = b.product_id
       WHERE b.status = 'active'
         AND b.deleted_at IS NULL
         AND b.effective_expiry_date <= CURRENT_DATE + ${rule.threshold_days}::int
         AND (${lowerBound}::int IS NULL
              OR b.effective_expiry_date > CURRENT_DATE + ${lowerBound}::int)
         AND (${rule.product_id}::uuid  IS NULL OR b.product_id  = ${rule.product_id}::uuid)
         AND (${rule.category_id}::uuid IS NULL OR p.category_id = ${rule.category_id}::uuid)
         AND (${rule.location_id}::uuid IS NULL OR b.location_id = ${rule.location_id}::uuid)
         /*
          * Scope is most-specific-wins: skip any batch that a narrower rule
          * already covers, so a custom rule on one product replaces the
          * organization ladder for it rather than adding a second alert.
          */
         AND NOT EXISTS (
           SELECT 1 FROM alert_rule r2
            WHERE r2.kind = 'expiry' AND r2.is_enabled AND r2.deleted_at IS NULL
              AND r2.id <> ${rule.id}
              AND (CASE WHEN r2.product_id  IS NOT NULL THEN 3
                        WHEN r2.category_id IS NOT NULL THEN 2
                        WHEN r2.location_id IS NOT NULL THEN 1
                        ELSE 0 END)
                  > (CASE WHEN ${rule.product_id}::uuid  IS NOT NULL THEN 3
                          WHEN ${rule.category_id}::uuid IS NOT NULL THEN 2
                          WHEN ${rule.location_id}::uuid IS NOT NULL THEN 1
                          ELSE 0 END)
              AND (r2.product_id  IS NULL OR r2.product_id  = b.product_id)
              AND (r2.category_id IS NULL OR r2.category_id = p.category_id)
              AND (r2.location_id IS NULL OR r2.location_id = b.location_id)
         )
      ON CONFLICT (alert_rule_id, batch_id) WHERE batch_id IS NOT NULL DO NOTHING
      RETURNING id`);

    created.push(...inserted.map((r) => r.id));
    lowerBound = rule.threshold_days;
  }

  return created;
}

/**
 * Turns freshly-raised events into one notification per recipient.
 *
 * Bundled rather than one message per alert: a pharmacy receiving forty
 * separate emails because forty lots crossed 90 days on the same night stops
 * reading any of them. Urgent thresholds still get their own immediate
 * message — that is what `severity` is for.
 */
async function notifyForEvents(
  tx: TenantTx,
  organizationId: string,
  eventIds: string[],
): Promise<number> {
  if (eventIds.length === 0) return 0;

  const recipients = await tx.execute<{ user_id: string; email: string; name: string }>(
    raw`SELECT user_id, email, name FROM alert_recipients(${organizationId}::uuid)`,
  );
  if (recipients.length === 0) return 0;

  /*
   * Ids travel as a single JSON parameter, not a JS array.
   *
   * Drizzle expands an array into one bind parameter per element, so
   * `ANY(${ids}::uuid[])` renders as `ANY(($1,$2,…)::uuid[])` — invalid SQL,
   * and with a few thousand events it exhausts the call stack while building
   * the query. One jsonb parameter is a fixed cost regardless of length.
   */
  const idsJson = JSON.stringify(eventIds);

  const [summary] = await tx.execute<{
    total: number; urgent: number; value_minor: number; currency: string; headline: string;
  }>(raw`
    WITH ids AS (
      SELECT (value #>> '{}')::uuid AS id FROM jsonb_array_elements(${idsJson}::jsonb)
    )
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE ae.severity <= 2)::int AS urgent,
           COALESCE(SUM(ae.value_at_risk_minor), 0)::bigint AS value_minor,
           COALESCE(MAX(ae.currency), 'NGN') AS currency,
           (SELECT p.name || ' expires in ' || ae2.days_remaining || ' days'
              FROM alert_event ae2
              JOIN product p ON p.id = ae2.product_id
             WHERE ae2.id IN (SELECT id FROM ids)
             ORDER BY ae2.days_remaining LIMIT 1) AS headline
      FROM alert_event ae
     WHERE ae.id IN (SELECT id FROM ids)
  `);

  const total = summary?.total ?? 0;
  const urgent = summary?.urgent ?? 0;
  const subject =
    urgent > 0
      ? `${urgent} urgent expiry alert${urgent === 1 ? '' : 's'}`
      : `${total} batch${total === 1 ? '' : 'es'} approaching expiry`;

  let queued = 0;
  for (const recipient of recipients) {
    const [notification] = await tx.execute<{ id: string }>(raw`
      INSERT INTO notification (
        organization_id, recipient_user_id, template, subject, payload,
        alert_event_ids, action_url
      ) VALUES (
        ${organizationId}, ${recipient.user_id},
        ${urgent > 0 ? 'expiry_urgent' : 'expiry_digest'},
        ${subject},
        ${JSON.stringify({
          total,
          urgent,
          valueAtRiskMinor: summary?.value_minor ?? 0,
          currency: summary?.currency ?? 'NGN',
          headline: summary?.headline ?? null,
        })}::jsonb,
        ${JSON.stringify(eventIds)}::jsonb,
        '/notifications'
      ) RETURNING id
    `);
    if (!notification) continue;

    /*
     * In-app is delivered the moment the row exists, so it is recorded as
     * 'sent'. Email and push are queued for a sender that does not exist yet —
     * recording them as queued rather than silently skipping means the backlog
     * is visible instead of invented later.
     */
    await tx.execute(raw`
      INSERT INTO notification_delivery (organization_id, notification_id, channel, destination, status, sent_at)
      VALUES
        (${organizationId}, ${notification.id}, 'in_app', NULL, 'sent', now()),
        (${organizationId}, ${notification.id}, 'email', ${recipient.email}, 'queued', NULL)
      ON CONFLICT (notification_id, channel) DO NOTHING
    `);
    queued++;
  }

  return queued;
}

export async function runExpiryScan(): Promise<ScanResult> {
  const startedAt = Date.now();
  const result: ScanResult = {
    organizationsScanned: 0,
    organizationsFailed: 0,
    alertsCreated: 0,
    notificationsQueued: 0,
    errors: [],
  };

  const orgs = await db.execute<OrgRow>(raw`SELECT id, name, timezone FROM organizations_to_scan()`);

  for (const org of orgs) {
    try {
      // One transaction per tenant: a failure in one pharmacy's data must not
      // roll back or block alerts for every other pharmacy.
      const { events, queued } = await withTenant({ organizationId: org.id }, async (tx) => {
        const [orgRow] = await tx.execute<{ currency: string }>(
          raw`SELECT default_currency AS currency FROM organization LIMIT 1`,
        );
        const events = await scanOrganization(tx, org.id, orgRow?.currency ?? 'NGN');
        const queued = await notifyForEvents(tx, org.id, events);
        return { events, queued };
      });
      result.organizationsScanned++;
      result.alertsCreated += events.length;
      result.notificationsQueued += queued;
    } catch (err) {
      /*
       * Recorded, not swallowed. An earlier version counted a scan where every
       * organization threw as a success with zero alerts — the most dangerous
       * possible outcome for an alerting system, because nothing looks wrong.
       */
      result.organizationsFailed++;
      result.errors.push({
        organizationId: org.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Recorded through a SECURITY DEFINER function: a job run is a system row
  // with no organization_id, which the tenant policy's WITH CHECK rejects.
  await db.execute(raw`
    SELECT record_job_run(
      'expiry_scan',
      ${result.errors.length > 0 ? 'failed' : 'succeeded'},
      ${Date.now() - startedAt},
      ${JSON.stringify({
        organizationsScanned: result.organizationsScanned,
        alertsCreated: result.alertsCreated,
        notificationsQueued: result.notificationsQueued,
      })}::jsonb,
      ${result.errors.length > 0 ? JSON.stringify(result.errors).slice(0, 4000) : null}
    )
  `);

  return result;
}
