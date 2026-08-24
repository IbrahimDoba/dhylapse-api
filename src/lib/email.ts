import { env } from '../env.ts';

/**
 * Transactional email.
 *
 * Two transports behind one interface. With RESEND_API_KEY set, mail goes out.
 * Without it, the message is logged and reported as sent — so the queueing,
 * retry and status-tracking path runs identically in development. Skipping
 * delivery entirely when unconfigured is how you discover on launch day that
 * the part you never exercised does not work.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface SendResult {
  ok: boolean;
  providerMessageId?: string | undefined;
  /** Distinguishes "this address is dead" from "try again shortly". */
  retryable?: boolean;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
}

export const emailProvider = env.RESEND_API_KEY ? 'resend' : 'console';

async function sendViaResend(message: EmailMessage): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // A network failure or timeout is always worth retrying.
    return {
      ok: false,
      retryable: true,
      errorCode: 'network',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  const body = (await res.json().catch(() => ({}))) as { id?: string; name?: string; message?: string };

  if (res.ok) return { ok: true, providerMessageId: body.id };

  /*
   * 4xx means the request itself is wrong — a malformed address, a domain that
   * is not verified. Retrying cannot fix it and just burns the queue. 429 and
   * 5xx are transient.
   */
  const retryable = res.status === 429 || res.status >= 500;
  return {
    ok: false,
    retryable,
    errorCode: body.name ?? String(res.status),
    errorMessage: body.message ?? `Resend returned ${res.status}`,
  };
}

function sendViaConsole(message: EmailMessage): SendResult {
  console.log(
    `\n── email (no RESEND_API_KEY, not actually sent) ──\n` +
      `to:      ${message.to}\n` +
      `subject: ${message.subject}\n\n${message.text}\n` +
      `────────────────────────────────────────────────\n`,
  );
  return { ok: true, providerMessageId: `console-${Date.now()}` };
}

export async function sendEmail(message: EmailMessage): Promise<SendResult> {
  return env.RESEND_API_KEY ? sendViaResend(message) : sendViaConsole(message);
}
