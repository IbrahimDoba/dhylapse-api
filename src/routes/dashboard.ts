import { sql as raw } from 'drizzle-orm';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { withTenant } from '../db/tenant.ts';
import { scopeWith } from '../lib/scope.ts';

/**
 * Dashboard summary.
 *
 * One round trip and one pass over the batch index, rather than the client
 * firing four count queries and adding them up. Every figure is computed
 * against CURRENT_DATE in the database, so the numbers cannot drift from the
 * inventory list the way the old hardcoded dashboard did.
 */
export const dashboardRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/api/dashboard',
    {
      preHandler: app.requireOrg,
      schema: {
        response: {
          200: Type.Object({
            expiring: Type.Object({
              expired: Type.Integer(),
              within7: Type.Integer(),
              within30: Type.Integer(),
              within90: Type.Integer(),
              within180: Type.Integer(),
            }),
            valueAtRiskMinor: Type.Object({
              within30: Type.Integer(),
              within90: Type.Integer(),
            }),
            totals: Type.Object({
              products: Type.Integer(),
              activeBatches: Type.Integer(),
              unitsOnHand: Type.Integer(),
              lowStockProducts: Type.Integer(),
              outOfStockProducts: Type.Integer(),
            }),
            currency: Type.String(),
          }),
        },
      },
    },
    async (req) => {
      const scope = scopeWith(req, 'inventory.read');

      return withTenant(scope, async (tx) => {
        const [batchStats] = await tx.execute<Record<string, number>>(raw`
          SELECT
            count(*) FILTER (WHERE effective_expiry_date <  CURRENT_DATE)::int AS expired,
            count(*) FILTER (WHERE effective_expiry_date >= CURRENT_DATE
                               AND effective_expiry_date <= CURRENT_DATE + 7)::int   AS within7,
            count(*) FILTER (WHERE effective_expiry_date >= CURRENT_DATE
                               AND effective_expiry_date <= CURRENT_DATE + 30)::int  AS within30,
            count(*) FILTER (WHERE effective_expiry_date >= CURRENT_DATE
                               AND effective_expiry_date <= CURRENT_DATE + 90)::int  AS within90,
            count(*) FILTER (WHERE effective_expiry_date >= CURRENT_DATE
                               AND effective_expiry_date <= CURRENT_DATE + 180)::int AS within180,
            COALESCE(SUM(unit_cost_minor * quantity_on_hand)
                     FILTER (WHERE effective_expiry_date <= CURRENT_DATE + 30), 0)::bigint AS "valueWithin30",
            COALESCE(SUM(unit_cost_minor * quantity_on_hand)
                     FILTER (WHERE effective_expiry_date <= CURRENT_DATE + 90), 0)::bigint AS "valueWithin90",
            count(*)::int AS "activeBatches",
            COALESCE(SUM(quantity_on_hand), 0)::int AS "unitsOnHand"
          FROM batch
          WHERE deleted_at IS NULL AND status = 'active'
        `);

        // Low stock is a product-level question: sum every active lot, then
        // compare against the reorder point. A product with no reorder point
        // set is not "low", it is untracked.
        const [productStats] = await tx.execute<Record<string, number>>(raw`
          WITH on_hand AS (
            SELECT p.id, p.reorder_point,
                   COALESCE(SUM(b.quantity_on_hand)
                            FILTER (WHERE b.status = 'active' AND b.deleted_at IS NULL), 0) AS qty
              FROM product p
              LEFT JOIN batch b ON b.product_id = p.id
             WHERE p.deleted_at IS NULL
             GROUP BY p.id, p.reorder_point
          )
          SELECT count(*)::int AS products,
                 count(*) FILTER (WHERE reorder_point IS NOT NULL
                                    AND qty > 0 AND qty <= reorder_point)::int AS "lowStockProducts",
                 count(*) FILTER (WHERE qty = 0)::int AS "outOfStockProducts"
            FROM on_hand
        `);

        const [org] = await tx.execute<{ currency: string }>(
          raw`SELECT default_currency AS currency FROM organization LIMIT 1`,
        );

        return {
          expiring: {
            expired: batchStats?.['expired'] ?? 0,
            within7: batchStats?.['within7'] ?? 0,
            within30: batchStats?.['within30'] ?? 0,
            within90: batchStats?.['within90'] ?? 0,
            within180: batchStats?.['within180'] ?? 0,
          },
          valueAtRiskMinor: {
            within30: batchStats?.['valueWithin30'] ?? 0,
            within90: batchStats?.['valueWithin90'] ?? 0,
          },
          totals: {
            products: productStats?.['products'] ?? 0,
            activeBatches: batchStats?.['activeBatches'] ?? 0,
            unitsOnHand: batchStats?.['unitsOnHand'] ?? 0,
            lowStockProducts: productStats?.['lowStockProducts'] ?? 0,
            outOfStockProducts: productStats?.['outOfStockProducts'] ?? 0,
          },
          currency: org?.currency ?? 'NGN',
        };
      });
    },
  );
};
