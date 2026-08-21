import { Type } from '@sinclair/typebox';

/**
 * Keyset pagination rather than OFFSET.
 *
 * A pharmacy's batch list is ordered by expiry and grows steadily. OFFSET makes
 * the database scan and discard every skipped row, so page 50 is far slower
 * than page 1 — and rows shifting between requests silently skip or duplicate
 * entries. A cursor over a stable sort key has neither problem.
 */
export const PaginationQuery = Type.Object({
  limit: Type.Integer({ minimum: 1, maximum: 200, default: 50 }),
  cursor: Type.Optional(Type.String({ maxLength: 200 })),
});

export const pageMeta = Type.Object({
  nextCursor: Type.Union([Type.String(), Type.Null()]),
  hasMore: Type.Boolean(),
});

/** Opaque to clients so the sort key can change without breaking them. */
export function encodeCursor(parts: (string | number)[]): string {
  return Buffer.from(JSON.stringify(parts)).toString('base64url');
}

export function decodeCursor(cursor: string): (string | number)[] | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return Array.isArray(parsed) ? (parsed as (string | number)[]) : null;
  } catch {
    return null;
  }
}
