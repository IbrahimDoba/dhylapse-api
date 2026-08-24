/**
 * Applies the full database setup, in order, with no psql dependency.
 *
 *   node --env-file=.env src/db/migrate.ts
 *
 * scripts/db-setup.sh does the same thing locally but shells out to psql,
 * which does not exist in a slim container. This runs the drizzle migrations
 * and then the hand-written SQL that drizzle cannot express — RLS policies,
 * ledger triggers, the app role, and the SECURITY DEFINER functions.
 *
 * Every step is idempotent (CREATE OR REPLACE, IF NOT EXISTS, guarded DO
 * blocks), so running it on every deploy is safe and means a container can
 * never come up against a half-migrated schema.
 */
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const here = dirname(fileURLToPath(import.meta.url));

const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_MIGRATION_URL (or DATABASE_URL) is required');

if (!process.env.DATABASE_MIGRATION_URL) {
  console.warn(
    'warning: falling back to DATABASE_URL. Migrations need DDL rights; the app role does not have them.',
  );
}

// max: 1 — DDL and advisory locks must run on a single connection.
const sql = postgres(url, { max: 1, onnotice: () => {} });

async function runFile(name: string, path: string) {
  const body = await readFile(path, 'utf8');
  process.stdout.write(`  ${name} … `);
  await sql.unsafe(body);
  console.log('ok');
}

try {
  /*
   * A session-level advisory lock around the whole run. Two containers
   * starting at once during a rolling deploy would otherwise race on CREATE
   * INDEX and one would fail its healthcheck.
   */
  await sql`SELECT pg_advisory_lock(918273645)`;

  console.log('applying database setup');

  await runFile('extensions', join(here, 'sql', '0001_extensions.sql'));

  process.stdout.write('  drizzle migrations … ');
  await migrate(drizzle(sql), { migrationsFolder: join(here, 'migrations') });
  console.log('ok');

  // Everything except 0001 (already applied) and 0003 (partitioning, a
  // deliberate manual step — see docs/SCHEMA.md).
  const files = (await readdir(join(here, 'sql')))
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => !f.startsWith('0001_') && !f.startsWith('0003_'))
    .sort();

  for (const f of files) {
    await runFile(f.replace(/\.sql$/, ''), join(here, 'sql', f));
  }

  const [counts] = await sql<{ tables: number; policies: number; triggers: number }[]>`
    SELECT (SELECT count(*)::int FROM information_schema.tables WHERE table_schema='public') AS tables,
           (SELECT count(*)::int FROM pg_policy) AS policies,
           (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal) AS triggers`;

  console.log(
    `done — ${counts?.tables} tables, ${counts?.policies} RLS policies, ${counts?.triggers} triggers`,
  );
} finally {
  await sql`SELECT pg_advisory_unlock(918273645)`.catch(() => {});
  await sql.end({ timeout: 5 });
}
