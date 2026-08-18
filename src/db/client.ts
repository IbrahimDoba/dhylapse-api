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
  // Set if you ever put PgBouncer in transaction mode in front of this.
  // prepare: false,
});

export const db = drizzle(sql, { schema, casing: 'snake_case' });

export type Database = typeof db;

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}
