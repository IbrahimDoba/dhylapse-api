import { AppError } from './errors.ts';

export interface NormalizedExpiry {
  /** Always a real date, so every comparison and index stays simple. */
  expiryDate: string;
  precision: 'day' | 'month';
}

/**
 * Normalises a printed expiry date.
 *
 * Pharmaceutical labels very often print only "EXP 06/2026". Forcing the user
 * to invent a day makes them distrust the record, so a month-only date is
 * stored as the last day of that month with the precision recorded alongside —
 * the UI can then render "Jun 2026" and alerting still has a real date to
 * compare against.
 *
 * Last day of month is the correct choice, not the first: stock is usable
 * throughout the printed month.
 */
export function normalizeExpiry(input: string): NormalizedExpiry {
  const trimmed = input.trim();

  const dayMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dayMatch) {
    const [, y, m, d] = dayMatch;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    if (
      date.getUTCFullYear() !== Number(y) ||
      date.getUTCMonth() !== Number(m) - 1 ||
      date.getUTCDate() !== Number(d)
    ) {
      throw new AppError(422, 'invalid_expiry', `"${input}" is not a real date.`);
    }
    return { expiryDate: trimmed, precision: 'day' };
  }

  const monthMatch = /^(\d{4})-(\d{2})$/.exec(trimmed);
  if (monthMatch) {
    const [, y, m] = monthMatch;
    const month = Number(m);
    if (month < 1 || month > 12) {
      throw new AppError(422, 'invalid_expiry', `"${input}" is not a real month.`);
    }
    // Day 0 of the following month is the last day of this one.
    const last = new Date(Date.UTC(Number(y), month, 0));
    return { expiryDate: last.toISOString().slice(0, 10), precision: 'month' };
  }

  throw new AppError(
    422,
    'invalid_expiry',
    `Expiry must be YYYY-MM-DD or YYYY-MM (got "${input}").`,
  );
}
