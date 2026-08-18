/**
 * Proves tenant isolation holds through the application's own code path.
 *
 * verify.sql tests the database in isolation; this tests the drizzle client,
 * the connection pool, and withTenant() together — which is where isolation
 * actually tends to break (a pooled connection retaining a setting, an ORM
 * opening its own implicit transaction, a query that skips the wrapper).
 *
 *   pnpm check:tenant     (requires verify.sql fixtures to be loaded)
 */
import { sql as raw } from 'drizzle-orm';
import { closeDb, db } from '../src/db/client.ts';
import { withTenant, withoutTenant, type TenantTx } from '../src/db/tenant.ts';

const ORG_A = '00000000-0000-7000-8000-0000000000a1';
const ORG_B = '00000000-0000-7000-8000-0000000000b1';

const countBatches = async (tx: TenantTx): Promise<number> =>
  Number((await tx.execute<{ n: number }>(raw`SELECT count(*)::int AS n FROM batch`))[0]?.n ?? -1);

let failures = 0;
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(34)} ${detail}`);
  if (!ok) failures++;
};

const a = await withTenant(ORG_A, countBatches);
check('scoped to org A', a === 1, `${a} batch(es) visible`);

const b = await withTenant(ORG_B, countBatches);
check('scoped to org B', b === 1, `${b} batch(es) visible`);

const none = await withoutTenant(countBatches);
check('no tenant set fails closed', none === 0, `${none} batch(es) visible`);

// A setting left on a pooled connection leaks into the next request to reuse it.
await withTenant(ORG_A, async () => {});
const leaked = (
  await db.execute<{ v: string | null }>(raw`SELECT current_setting('app.organization_id', true) AS v`)
)[0]?.v;
check('no leak onto pooled conn', !leaked, leaked ? `leaked "${leaked}"` : 'setting cleared');

let blocked = false;
try {
  await withTenant(ORG_A, async (tx) => {
    await tx.execute(raw`INSERT INTO product (organization_id, name) VALUES (${ORG_B}, 'smuggled')`);
  });
} catch {
  blocked = true;
}
check('cross-tenant write blocked', blocked, blocked ? 'rejected by WITH CHECK' : 'ALLOWED — LEAK');

await closeDb();
console.log(failures === 0 ? '\nall tenant checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
