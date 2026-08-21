/**
 * Seeds a realistically-sized dataset for performance work.
 *
 *   pnpm seed:perf [batchesPerOrg]     default 20000
 *
 * Three organizations, not one: RLS adds a predicate to every query, and its
 * cost only shows up when there is other tenants' data for it to filter out.
 * A single-tenant database makes every isolation query look free.
 *
 * Connects with the PRIVILEGED role and bypasses RLS deliberately — this is a
 * fixture loader, not application behaviour. It writes quantity_on_hand
 * directly rather than through the ledger, because the point is to exercise
 * read paths; ledger write throughput is measured separately in perf-check.
 */
import postgres from 'postgres';

const url = process.env.DATABASE_MIGRATION_URL;
if (!url) throw new Error('DATABASE_MIGRATION_URL is required');

const BATCHES_PER_ORG = Number(process.argv[2] ?? 20_000);
const PRODUCTS_PER_ORG = 400;
const ORGS = ['Greenline Pharmacy', 'Lagoon Chemists', 'Ikoyi Dispensary'];

const sql = postgres(url, { max: 4, onnotice: () => {} });
const t0 = Date.now();

console.log(`seeding ${ORGS.length} orgs x ${BATCHES_PER_ORG.toLocaleString()} batches`);

for (const [i, orgName] of ORGS.entries()) {
  const slug = `perf-${i}`;
  const email = `perf-owner-${i}@example.test`;

  const [user] = await sql`
    INSERT INTO app_user (email, name) VALUES (${email}, ${'Owner ' + i})
    ON CONFLICT (email) WHERE deleted_at IS NULL DO UPDATE SET name = EXCLUDED.name
    RETURNING id`;

  const existing = await sql`SELECT id FROM organization WHERE slug = ${slug}`;
  if (existing.length > 0) {
    console.log(`  ${orgName}: already seeded, skipping`);
    continue;
  }

  const [{ bootstrap_organization: orgId }] = await sql`
    SELECT bootstrap_organization(${user!.id}::uuid, ${orgName}, ${slug})`;

  const [{ id: locationId }] = await sql`
    SELECT id FROM location WHERE organization_id = ${orgId} LIMIT 1`;

  // A second location for the larger org, so location filtering is meaningful.
  let locations = [locationId];
  if (i === 0) {
    const [{ id: second }] = await sql`
      INSERT INTO location (organization_id, name, code)
      VALUES (${orgId}, 'Ikeja Branch', 'IKJ') RETURNING id`;
    locations = [locationId, second];
  }

  await sql`
    INSERT INTO product (organization_id, name, sku, reorder_point, target_stock_level)
    SELECT ${orgId},
           'Product ' || g || ' ' || (10 * (1 + (g % 50))) || 'mg',
           'SKU-' || ${i} || '-' || lpad(g::text, 5, '0'),
           (20 + (g % 80))::bigint,
           (200 + (g % 400))::bigint
      FROM generate_series(1, ${PRODUCTS_PER_ORG}) g`;

  const productIds = (
    await sql<{ id: string }[]>`SELECT id FROM product WHERE organization_id = ${orgId}`
  ).map((r) => r.id);

  /**
   * Expiry spread modelled on a real shelf: a long tail out to three years,
   * a meaningful cluster inside the alert windows, and some already-expired
   * stock that nobody has cleared yet. A uniform spread would make the
   * partial index look better than it is.
   */
  await sql`
    INSERT INTO batch (
      organization_id, location_id, product_id, batch_number,
      expiry_date, expiry_precision, quantity_on_hand, quantity_received,
      unit_cost_minor, currency, status
    )
    SELECT ${orgId},
           (${locations}::uuid[])[1 + (g % ${locations.length})],
           (${productIds}::uuid[])[1 + (g % ${productIds.length})],
           'LOT-' || ${i} || '-' || lpad(g::text, 7, '0'),
           CURRENT_DATE + (
             CASE
               WHEN g % 100 <  4 THEN -1 * (1 + (g % 90))        -- already expired
               WHEN g % 100 < 10 THEN (g % 7)                    -- inside 7 days
               WHEN g % 100 < 22 THEN 8  + (g % 22)              -- inside 30
               WHEN g % 100 < 42 THEN 31 + (g % 59)              -- inside 90
               WHEN g % 100 < 65 THEN 91 + (g % 89)              -- inside 180
               ELSE 181 + (g % 900)                              -- long tail
             END
           ) * INTERVAL '1 day',
           CASE WHEN g % 5 = 0 THEN 'month' ELSE 'day' END,
           (1 + (g % 500))::bigint,
           (1 + (g % 500))::bigint,
           (500 + (g % 90000))::bigint,
           'NGN',
           CASE WHEN g % 50 = 0 THEN 'depleted' ELSE 'active' END
      FROM generate_series(1, ${BATCHES_PER_ORG}) g`;

  console.log(`  ${orgName}: ${PRODUCTS_PER_ORG} products, ${BATCHES_PER_ORG.toLocaleString()} batches`);
}

await sql`ANALYZE batch`;
await sql`ANALYZE product`;
await sql`ANALYZE stock_movement`;

const [counts] = await sql`
  SELECT (SELECT count(*) FROM organization)::int AS orgs,
         (SELECT count(*) FROM product)::int      AS products,
         (SELECT count(*) FROM batch)::int        AS batches,
         pg_size_pretty(pg_total_relation_size('batch')) AS batch_size`;

console.log(
  `\n${counts!.orgs} orgs, ${counts!.products.toLocaleString()} products, ` +
  `${counts!.batches.toLocaleString()} batches (${counts!.batch_size}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
);
await sql.end();
