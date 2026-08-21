import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env.ts';
import * as schema from './schema/index.ts';

/**
 * One pool, connecting as the unprivileged application role so RLS applies.
 *
 * `onnotice` is silenced because the ledger triggers emit NOTICEs that are
 * useful in psql and pure noise in application logs.
 */
export const sql = postgres(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  onnotice: () => {},
  types: {
    /**
     * Postgres int8 arrives as a string by default, because it can exceed
     * JavaScript's safe integer range. Every bigint in this schema is a
     * quantity or an amount in minor units — the largest realistic value is a
     * few billion kobo, nowhere near 2^53 — so parsing to Number keeps the
     * JSON API free of stringly-typed numbers.
     *
     * If a column is ever added that can genuinely exceed 9e15, it must not
     * use this path.
     */
    int8: { to: 20, from: [20], serialize: String, parse: Number },
  },
  // Set if you ever put PgBouncer in transaction mode in front of this.
  // prepare: false,
});

export const db = drizzle(sql, { schema, casing: 'snake_case' });

export type Database = typeof db;

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}
