/**
 * Performance checks against the hot read paths.
 *
 *   pnpm seed:perf && pnpm perf
 *
 * Everything runs through withTenant as the unprivileged app role, so RLS is
 * active — measuring raw SQL as a superuser would flatter every number here.
 * Each check asserts a wall-clock budget AND the query plan, because a query
 * that is fast on 60k rows and seq-scanning is a query that will fall over at
 * 600k. The plan assertion is the one that catches a regression early.
 */
import { sql as raw } from 'drizzle-orm';
import { closeDb, db } from '../src/db/client.ts';
import { withTenant, withUser } from '../src/db/tenant.ts';

const ITERATIONS = 40;
let failures = 0;

/**
 * Resolved in two steps because RLS is doing its job: `organization` is
 * invisible without a tenant or an identity, so a bare lookup returns nothing.
 * app_user carries no RLS (better-auth must find a user before any tenant
 * exists), and withUser then exposes exactly the orgs this person belongs to.
 */
const [owner] = await db.execute<{ id: string }>(
  raw`SELECT id FROM app_user WHERE email = 'perf-owner-0@example.test'`,
);
if (!owner) throw new Error('perf fixtures missing — run: pnpm seed:perf');
const userId = owner.id;

const [org] = await withUser(userId, (tx) =>
  tx.execute<{ id: string }>(raw`SELECT id FROM organization WHERE slug = 'perf-0'`),
);
if (!org) throw new Error('perf org missing — run: pnpm seed:perf');
const orgId = org.id;

const scope = { organizationId: orgId, userId };

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

async function measure(
  label: string,
  budgetMs: number,
  query: ReturnType<typeof raw>,
  opts: { expectIndex?: string; forbidSeqScanOn?: string; cursorMustBeIndexed?: boolean } = {},
) {
  // Warm the cache; a cold first run measures disk, not the query.
  await withTenant(scope, (tx) => tx.execute(query));

  const timings: number[] = [];
  let rows = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    const t = performance.now();
    const result = await withTenant(scope, (tx) => tx.execute(query));
    timings.push(performance.now() - t);
    rows = result.length;
  }

  const p50 = percentile(timings, 50);
  const p95 = percentile(timings, 95);

  const plan = await withTenant(scope, async (tx) => {
    const out = await tx.execute<Record<string, string>>(
      raw`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${query}`,
    );
    return out.map((r) => Object.values(r)[0]).join('\n');
  });

  let planOk = true;
  const notes: string[] = [];

  if (opts.expectIndex && !plan.includes(opts.expectIndex)) {
    planOk = false;
    notes.push(`expected index ${opts.expectIndex} unused`);
  }
  if (opts.forbidSeqScanOn && new RegExp(`Seq Scan on ${opts.forbidSeqScanOn}\\b`).test(plan)) {
    planOk = false;
    notes.push(`seq scan on ${opts.forbidSeqScanOn}`);
  }
  /**
   * The cursor comparison must land in Index Cond, not Filter.
   *
   * If it degrades to a Filter, Postgres walks the tenant's entire index and
   * discards rows one at a time — pagination silently becomes O(offset). It
   * still returns correct results, so only a plan assertion catches it. A
   * single implicit date -> timestamp coercion on the cursor is enough to
   * cause it, and it measured 1,400x slower at 600k rows.
   */
  if (opts.cursorMustBeIndexed) {
    const cond = plan.split('\n').find((l) => l.includes('Index Cond')) ?? '';
    if (!cond.includes('ROW(')) {
      planOk = false;
      notes.push('cursor fell out of Index Cond into Filter — pagination is O(offset)');
    }
  }

  const timeOk = p95 <= budgetMs;
  const ok = timeOk && planOk;
  if (!ok) failures++;

  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(38)} ` +
    `p50 ${p50.toFixed(1).padStart(6)}ms  p95 ${p95.toFixed(1).padStart(6)}ms  ` +
    `(budget ${budgetMs}ms)  ${String(rows).padStart(4)} rows` +
    (notes.length ? `\n      ${notes.join('; ')}` : ''),
  );
  return { p50, p95, plan };
}

console.log(`\nRLS active, ${ITERATIONS} iterations each\n`);

// The nightly expiry scan and the dashboard both hit this shape. It is the
// single hottest query in the product.
await measure(
  'expiry scan, 90-day window',
  8,
  raw`SELECT b.id, b.expiry_date, b.quantity_on_hand
        FROM batch b
       WHERE b.deleted_at IS NULL AND b.status = 'active'
         AND b.effective_expiry_date
             <= CURRENT_DATE + INTERVAL '90 days'
       ORDER BY b.effective_expiry_date, b.id
       LIMIT 50`,
  { forbidSeqScanOn: 'batch', expectIndex: 'batch_expiry_scan_idx' },
);

const first = await measure(
  'inventory list, first page (FEFO)',
  8,
  raw`SELECT b.id, b.expiry_date, p.name
        FROM batch b JOIN product p ON p.id = b.product_id
       WHERE b.deleted_at IS NULL AND b.status = 'active'
       ORDER BY b.effective_expiry_date, b.id
       LIMIT 50`,
  { forbidSeqScanOn: 'batch', expectIndex: 'batch_expiry_scan_idx' },
);

// Keyset pagination should cost the same on page 200 as on page 1. This is the
// whole reason the API returns a cursor instead of accepting an offset.
/**
 * The cursor is read from real data and passed as a genuine `date`, exactly as
 * the API sends it. Deriving it with CURRENT_DATE + INTERVAL yields a
 * timestamp, and that coercion alone drops the row comparison out of the index
 * and into a Filter — 1,400x slower at 600k rows, with identical results.
 */
const [cursorRow] = await withTenant(scope, (tx) =>
  tx.execute<{ d: string; id: string }>(raw`
    SELECT effective_expiry_date::text AS d, id FROM batch
     WHERE status = 'active' AND deleted_at IS NULL
     ORDER BY effective_expiry_date, id OFFSET 10000 LIMIT 1`),
);
const cursorDate = cursorRow!.d;
const cursorId = cursorRow!.id;

const deep = await measure(
  'inventory list, page 200 (keyset)',
  8,
  raw`SELECT b.id, b.expiry_date, p.name
        FROM batch b JOIN product p ON p.id = b.product_id
       WHERE b.deleted_at IS NULL AND b.status = 'active'
         AND (b.effective_expiry_date, b.id)
             > (${cursorDate}::date, ${cursorId}::uuid)
       ORDER BY b.effective_expiry_date, b.id
       LIMIT 50`,
  { forbidSeqScanOn: 'batch', expectIndex: 'batch_expiry_scan_idx', cursorMustBeIndexed: true },
);

// The same page reached with OFFSET, for comparison. Not a pass/fail — it
// exists to show what the cursor is buying.
const offsetRun = await measure(
  'same page via OFFSET 10000 (control)',
  5000,
  raw`SELECT b.id, b.expiry_date, p.name
        FROM batch b JOIN product p ON p.id = b.product_id
       WHERE b.deleted_at IS NULL AND b.status = 'active'
       ORDER BY b.effective_expiry_date, b.id
       OFFSET 10000 LIMIT 50`,
);

await measure(
  'product rollup (LATERAL per page)',
  25,
  raw`SELECT p.id, p.name, agg.qty, agg.batches
        FROM (SELECT * FROM product WHERE deleted_at IS NULL
               ORDER BY name, id LIMIT 50) p
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(b.quantity_on_hand), 0)::int AS qty, count(*)::int AS batches
            FROM batch b
           WHERE b.product_id = p.id AND b.deleted_at IS NULL AND b.status = 'active'
        ) agg ON true
       ORDER BY p.name, p.id`,
  { forbidSeqScanOn: 'batch' },
);

await measure(
  'value at risk, 30-day window',
  40,
  raw`SELECT COALESCE(SUM(b.unit_cost_minor * b.quantity_on_hand), 0)::bigint AS value_minor,
             count(*)::int AS lots
        FROM batch b
       WHERE b.deleted_at IS NULL AND b.status = 'active'
         AND b.effective_expiry_date
             <= CURRENT_DATE + INTERVAL '30 days'`,
  { forbidSeqScanOn: 'batch' },
);

// --- ledger write throughput ------------------------------------------------
// The trigger takes FOR UPDATE on the batch row, so writes serialise per lot.
// Worth knowing the real number rather than assuming.
const [{ id: batchId, pid: productId, lid: locationId }] = await withTenant(scope, (tx) =>
  tx.execute<{ id: string; pid: string; lid: string }>(raw`
    SELECT id, product_id AS pid, location_id AS lid
      FROM batch WHERE status = 'active' AND quantity_on_hand > 400 LIMIT 1`),
);

const WRITES = 100;
const wStart = performance.now();
for (let i = 0; i < WRITES; i++) {
  await withTenant(scope, (tx) =>
    tx.execute(raw`
      INSERT INTO stock_movement (organization_id, location_id, batch_id, product_id,
                                  quantity_delta, balance_after, reason, actor_id)
      VALUES (${orgId}, ${locationId}, ${batchId}, ${productId}, -1, 0, 'dispense', ${userId})`),
  );
}
const perWrite = (performance.now() - wStart) / WRITES;
const writeOk = perWrite < 25;
if (!writeOk) failures++;
console.log(
  `${writeOk ? 'PASS' : 'FAIL'}  ${'ledger write (locked, serialised)'.padEnd(38)} ` +
  `${perWrite.toFixed(1)}ms/write  ${Math.round(1000 / perWrite)}/s  (budget 25ms)`,
);

console.log(
  `\nkeyset page 200 vs page 1: ${(deep.p50 / first.p50).toFixed(2)}x   ` +
  `OFFSET equivalent: ${(offsetRun.p50 / first.p50).toFixed(2)}x`,
);

await closeDb();
console.log(failures === 0 ? '\nall performance checks passed' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
