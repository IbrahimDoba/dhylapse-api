/**
 * Proves tenant isolation holds through the application's own code path.
 *
 * verify.sql tests the database in isolation; this tests the drizzle client,
 * the connection pool, and withTenant() together — which is where isolation
 * actually tends to break (a pooled connection retaining a setting, an ORM
 * opening its own implicit transaction, a query that skips the wrapper).
 *
 *   pnpm check:tenant
 *
 * Seeds its own fixtures idempotently, so it is safe to run repeatedly.
 */
import { sql as raw } from 'drizzle-orm';
import { closeDb, db } from '../src/db/client.ts';
import { withTenant, withUser, withoutTenant, type TenantTx } from '../src/db/tenant.ts';

/**
 * Seeds via the real signup path: app_user has no RLS (better-auth must find a
 * user by email before any tenant exists), then bootstrap_organization creates
 * the org, location, owner membership and alert rules. Tenant tables cannot be
 * seeded any other way from the app role — which is the point.
 */
const USER_A = '00000000-0000-7000-8000-0000000000f1';
const USER_B = '00000000-0000-7000-8000-0000000000f2';

async function ensureOrg(userId: string, email: string, name: string, slug: string) {
  await withoutTenant(async (tx) => {
    await tx.execute(raw`
      INSERT INTO app_user (id, email, name) VALUES (${userId}, ${email}, ${name})
      ON CONFLICT (id) DO NOTHING`);
  });

  const existing = await withUser(userId, async (tx) =>
    tx.execute<{ id: string }>(raw`
      SELECT o.id FROM organization o
        JOIN membership m ON m.organization_id = o.id AND m.user_id = ${userId}
       WHERE o.slug = ${slug} LIMIT 1`),
  );
  if (existing[0]?.id) return existing[0].id;

  const created = await withUser(userId, async (tx) =>
    tx.execute<{ bootstrap_organization: string }>(
      raw`SELECT bootstrap_organization(${userId}::uuid, ${name}, ${slug})`,
    ),
  );
  const orgId = created[0]!.bootstrap_organization;

  await withTenant({ organizationId: orgId, userId }, async (tx) => {
    await tx.execute(raw`
      INSERT INTO product (organization_id, name) VALUES (${orgId}, 'Test Product')`);
    await tx.execute(raw`
      INSERT INTO batch (organization_id, location_id, product_id, batch_number, expiry_date)
      SELECT ${orgId}, l.id, p.id, 'LOT-1', DATE '2027-01-31'
        FROM location l, product p
       WHERE l.organization_id = ${orgId} AND p.organization_id = ${orgId} LIMIT 1`);
  });
  return orgId;
}

const ORG_A = await ensureOrg(USER_A, 'checka@example.test', 'Check Pharmacy A', 'check-a');
const ORG_B = await ensureOrg(USER_B, 'checkb@example.test', 'Check Pharmacy B', 'check-b');

const countBatches = async (tx: TenantTx): Promise<number> =>
  Number((await tx.execute<{ n: number }>(raw`SELECT count(*)::int AS n FROM batch`))[0]?.n ?? -1);

let failures = 0;
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(34)} ${detail}`);
  if (!ok) failures++;
};

const a = await withTenant({ organizationId: ORG_A, userId: USER_A }, countBatches);
check('scoped to org A', a === 1, `${a} batch(es) visible`);

const b = await withTenant({ organizationId: ORG_B, userId: USER_B }, countBatches);
check('scoped to org B', b === 1, `${b} batch(es) visible`);

const none = await withoutTenant(countBatches);
check('no tenant set fails closed', none === 0, `${none} batch(es) visible`);

// A setting left on a pooled connection leaks into the next request to reuse it.
await withTenant({ organizationId: ORG_A, userId: USER_A }, async () => {});
const leaked = (
  await db.execute<{ v: string | null }>(raw`SELECT current_setting('app.organization_id', true) AS v`)
)[0]?.v;
check('no leak onto pooled conn', !leaked, leaked ? `leaked "${leaked}"` : 'setting cleared');

let blocked = false;
try {
  await withTenant({ organizationId: ORG_A, userId: USER_A }, async (tx) => {
    await tx.execute(raw`INSERT INTO product (organization_id, name) VALUES (${ORG_B}, 'smuggled')`);
  });
} catch {
  blocked = true;
}
check('cross-tenant write blocked', blocked, blocked ? 'rejected by WITH CHECK' : 'ALLOWED — LEAK');

await closeDb();
console.log(failures === 0 ? '\nall tenant checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
