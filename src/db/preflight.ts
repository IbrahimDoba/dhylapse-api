import { sql as raw } from 'drizzle-orm';
import { db } from './client.ts';

/**
 * Boot-time check that the database is actually configured the way the
 * application assumes.
 *
 * The failure this exists to prevent: running `db:migrate` without the RLS and
 * trigger steps produces a schema that looks completely correct and works in
 * every manual test, while having no tenant isolation and no ledger
 * enforcement. Nothing surfaces it — the first sign is one pharmacy seeing
 * another's stock. So the server refuses to start instead.
 */

interface Problem {
  what: string;
  fix: string;
}

export async function preflight(): Promise<void> {
  const problems: Problem[] = [];

  const [role] = await db.execute<{
    current_user: string;
    is_superuser: boolean;
    bypassrls: boolean;
  }>(raw`
    SELECT current_user,
           rolsuper   AS is_superuser,
           rolbypassrls AS bypassrls
      FROM pg_roles WHERE rolname = current_user
  `);

  if (role?.is_superuser || role?.bypassrls) {
    problems.push({
      what: `connected as "${role.current_user}", which bypasses row-level security`,
      fix: 'Point DATABASE_URL at the unprivileged app role (dhylapse_app), not the migration role.',
    });
  }

  const rls = await db.execute<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(raw`
    SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
     WHERE relname IN ('batch','stock_movement','product','alert_event')
       AND relkind = 'r'
  `);

  const missingRls = rls.filter((t) => !t.relrowsecurity || !t.relforcerowsecurity);
  if (rls.length === 0) {
    problems.push({
      what: 'core tables are missing',
      fix: 'Run: pnpm db:migrate',
    });
  } else if (missingRls.length > 0) {
    problems.push({
      what: `row-level security is not enabled on: ${missingRls.map((t) => t.relname).join(', ')}`,
      fix: 'Run: psql "$DATABASE_MIGRATION_URL" -f src/db/sql/0002_rls.sql',
    });
  }

  const [trigger] = await db.execute<{ n: number }>(raw`
    SELECT count(*)::int AS n FROM pg_trigger
     WHERE tgname IN ('stock_movement_apply','stock_movement_immutable','batch_effective_expiry')
       AND NOT tgisinternal
  `);

  if ((trigger?.n ?? 0) < 3) {
    problems.push({
      what: `ledger triggers missing (found ${trigger?.n ?? 0} of 3)`,
      fix: 'Run: psql "$DATABASE_MIGRATION_URL" -f src/db/sql/0004_derived.sql',
    });
  }

  if (problems.length > 0) {
    const report = problems.map((p) => `  ✗ ${p.what}\n    → ${p.fix}`).join('\n\n');
    throw new Error(
      `Database is not correctly configured — refusing to start.\n\n${report}\n\n` +
        'See README "Setup" for the full apply order.',
    );
  }
}
