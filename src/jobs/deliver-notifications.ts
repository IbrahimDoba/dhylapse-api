import { sql as raw } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { withTenant } from '../db/tenant.ts';
import { emailProvider, sendEmail } from '../lib/email.ts';
import { renderExpiryDigest, type AlertLine } from '../lib/templates.ts';

/**
 * Drains queued email deliveries.
 *
 * The scan writes notification_delivery rows as 'queued' and stops there;
 * sending is separate on purpose. A provider outage must not roll back a scan
 * or lose the alerts it raised — the alert is the durable thing, the email is
 * a best-effort copy of it.
 */

export interface DeliveryResult {
  attempted: number;
  sent: number;
  failed: number;
  abandoned: number;
}

/** Exponential backoff, capped. Attempt 1 waits 1 min, attempt 5 waits ~4 hours. */
const BACKOFF_MINUTES = [1, 5, 30, 120, 240];
const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 100;

interface Pending extends Record<string, unknown> {
  delivery_id: string;
  organization_id: string;
  notification_id: string;
  destination: string | null;
  attempts: number;
  subject: string;
  payload: { total?: number; urgent?: number; critical?: number; valueAtRiskMinor?: number; currency?: string };
  alert_event_ids: string[];
  recipient_name: string;
  organization_name: string;
}

export async function deliverQueuedEmails(): Promise<DeliveryResult> {
  const startedAt = Date.now();
  const result: DeliveryResult = { attempted: 0, sent: 0, failed: 0, abandoned: 0 };

  const orgs = await db.execute<{ id: string }>(raw`SELECT id FROM organizations_to_scan()`);

  for (const org of orgs) {
    const pending = await withTenant({ organizationId: org.id }, (tx) =>
      tx.execute<Pending>(raw`
        SELECT d.id AS delivery_id, d.organization_id, d.notification_id,
               d.destination, d.attempts,
               n.subject, n.payload, n.alert_event_ids,
               u.name AS recipient_name,
               o.name AS organization_name
          FROM notification_delivery d
          JOIN notification n ON n.id = d.notification_id
          JOIN app_user u     ON u.id = n.recipient_user_id
          JOIN organization o ON o.id = d.organization_id
         WHERE d.channel = 'email'
           AND d.status IN ('queued', 'failed')
           AND d.attempts < ${MAX_ATTEMPTS}
           AND (d.next_retry_at IS NULL OR d.next_retry_at <= now())
         ORDER BY d.queued_at
         LIMIT ${BATCH_SIZE}`),
    );

    for (const row of pending) {
      result.attempted++;

      if (!row.destination) {
        await withTenant({ organizationId: org.id }, (tx) =>
          tx.execute(raw`
            UPDATE notification_delivery
               SET status = 'suppressed', error_code = 'no_destination',
                   error_message = 'No email address on file'
             WHERE id = ${row.delivery_id}`),
        );
        result.abandoned++;
        continue;
      }

      // Alert detail is read now rather than stored on the notification, so a
      // retry three hours later reflects what actually happened since.
      const lines = await withTenant({ organizationId: org.id }, (tx) =>
        tx.execute<AlertLine & Record<string, unknown>>(raw`
          WITH ids AS (
            SELECT (value #>> '{}')::uuid AS id
              FROM jsonb_array_elements(${JSON.stringify(row.alert_event_ids)}::jsonb)
          )
          SELECT p.name                       AS "productName",
                 b.batch_number               AS "batchNumber",
                 COALESCE(b.effective_expiry_date - CURRENT_DATE, ae.days_remaining)::int AS "daysRemaining",
                 ae.quantity_at_alert::int    AS quantity,
                 ae.value_at_risk_minor::int  AS "valueMinor"
            FROM alert_event ae
            JOIN product p ON p.id = ae.product_id
            LEFT JOIN batch b ON b.id = ae.batch_id
           WHERE ae.id IN (SELECT id FROM ids)
           ORDER BY "daysRemaining"
           LIMIT 25`),
      );

      const currency = row.payload?.currency ?? 'NGN';
      const message = renderExpiryDigest({
        pharmacyName: row.organization_name,
        recipientName: row.recipient_name.split(' ')[0] ?? row.recipient_name,
        lines: lines as AlertLine[],
        totalValueMinor: row.payload?.valueAtRiskMinor ?? 0,
        currency,
        critical: row.payload?.critical ?? 0,
      });

      const send = await sendEmail({
        to: row.destination,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });

      const attempts = row.attempts + 1;

      if (send.ok) {
        await withTenant({ organizationId: org.id }, (tx) =>
          tx.execute(raw`
            UPDATE notification_delivery
               SET status = 'sent', sent_at = now(), attempts = ${attempts},
                   provider = ${emailProvider},
                   provider_message_id = ${send.providerMessageId ?? null},
                   next_retry_at = NULL, error_code = NULL, error_message = NULL
             WHERE id = ${row.delivery_id}`),
        );
        result.sent++;
        continue;
      }

      /*
       * A permanent rejection — malformed address, unverified domain — is
       * abandoned immediately. Retrying it five times cannot help and delays
       * every other message behind it in the queue.
       */
      const giveUp = send.retryable === false || attempts >= MAX_ATTEMPTS;
      const waitMinutes = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)]!;

      await withTenant({ organizationId: org.id }, (tx) =>
        tx.execute(raw`
          UPDATE notification_delivery
             SET status = ${giveUp ? 'failed' : 'queued'},
                 attempts = ${attempts},
                 provider = ${emailProvider},
                 error_code = ${send.errorCode ?? 'unknown'},
                 error_message = ${send.errorMessage ?? null},
                 next_retry_at = ${giveUp ? null : raw`now() + (${waitMinutes} * INTERVAL '1 minute')`}
           WHERE id = ${row.delivery_id}`),
      );

      if (giveUp) result.abandoned++;
      else result.failed++;
    }
  }

  if (result.attempted > 0) {
    await db.execute(raw`
      SELECT record_job_run(
        'deliver_notifications',
        ${result.abandoned > 0 ? 'failed' : 'succeeded'},
        ${Date.now() - startedAt},
        ${JSON.stringify(result)}::jsonb,
        NULL
      )`);
  }

  return result;
}
