import { env } from '../env.ts';

/**
 * Email bodies for expiry alerts.
 *
 * Plain text first, HTML derived from the same content. Written to be useful
 * in a notification preview on a phone: the number that matters is in the
 * subject and the first line, because that is all most people will read.
 */

export interface AlertLine {
  productName: string;
  batchNumber: string | null;
  daysRemaining: number;
  quantity: number;
  valueMinor: number | null;
}

const money = (minor: number | null, currency: string) =>
  minor == null
    ? ''
    : new Intl.NumberFormat('en-NG', { style: 'currency', currency, maximumFractionDigits: 0 }).format(
        minor / 100,
      );

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const describe = (days: number) =>
  days < 0 ? `expired ${Math.abs(days)} days ago` : days === 0 ? 'expires today' : `${days} days left`;

export function renderExpiryDigest(input: {
  pharmacyName: string;
  recipientName: string;
  lines: AlertLine[];
  totalValueMinor: number;
  currency: string;
  /** Count on the 7-day rung specifically — what the subject line claims. */
  critical: number;
}): { subject: string; text: string; html: string } {
  const { pharmacyName, recipientName, lines, totalValueMinor, currency, critical } = input;
  const appUrl = env.PUBLIC_APP_URL ?? env.BETTER_AUTH_URL;
  const total = lines.length;

  const subject =
    critical > 0
      ? `${critical} batch${critical === 1 ? '' : 'es'} expiring within 7 days — ${pharmacyName}`
      : `${total} batch${total === 1 ? '' : 'es'} approaching expiry — ${pharmacyName}`;

  const worth = totalValueMinor > 0 ? ` worth ${money(totalValueMinor, currency)}` : '';

  const text = [
    `Hi ${recipientName},`,
    '',
    `${total} batch${total === 1 ? '' : 'es'}${worth} at ${pharmacyName} ${total === 1 ? 'has' : 'have'} crossed an expiry threshold.`,
    '',
    ...lines.map(
      (l) =>
        `  • ${l.productName}${l.batchNumber ? ` (${l.batchNumber})` : ''} — ${describe(l.daysRemaining)}, ` +
        `${l.quantity} units${l.valueMinor ? `, ${money(l.valueMinor, currency)}` : ''}`,
    ),
    '',
    `Review them: ${appUrl}/notifications`,
    '',
    '— Dhylapse',
  ].join('\n');

  const rows = lines
    .map(
      (l) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #e5e7eb">
          <div style="font-weight:700;color:#171717">${escape(l.productName)}</div>
          <div style="font-size:13px;color:#6b7a77">${escape(l.batchNumber ?? 'No lot number')} · ${l.quantity} units</div>
        </td>
        <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;text-align:right;white-space:nowrap">
          <div style="font-weight:700;color:${l.daysRemaining <= 7 ? '#b91c1c' : '#171717'}">${escape(describe(l.daysRemaining))}</div>
          <div style="font-size:13px;color:#6b7a77">${escape(money(l.valueMinor, currency))}</div>
        </td>
      </tr>`,
    )
    .join('');

  const html = `<!doctype html>
<html><body style="margin:0;background:#f6f8f7;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px">
    <div style="background:#ffffff;border-radius:20px;padding:28px">
      <p style="margin:0 0 4px;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#245b56">${escape(pharmacyName)}</p>
      <h1 style="margin:0 0 8px;font-size:22px;line-height:1.25;color:#11201e">
        ${total} batch${total === 1 ? '' : 'es'} approaching expiry
      </h1>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#38504c">
        Hi ${escape(recipientName)} — ${total === 1 ? 'this lot has' : 'these lots have'} crossed an expiry threshold${
          totalValueMinor > 0 ? `, worth <strong>${escape(money(totalValueMinor, currency))}</strong> in total` : ''
        }.
      </p>
      <table style="width:100%;border-collapse:collapse;font-size:15px">${rows}</table>
      <a href="${appUrl}/notifications"
         style="display:inline-block;margin-top:24px;background:#245b56;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:700;font-size:15px">
        Review in Dhylapse
      </a>
    </div>
    <p style="margin:18px 0 0;text-align:center;font-size:12px;color:#6b7a77">
      You receive this because you are a member of ${escape(pharmacyName)} on Dhylapse.
    </p>
  </div>
</body></html>`;

  return { subject, text, html };
}
