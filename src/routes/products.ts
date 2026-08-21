import { sql as raw } from 'drizzle-orm';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { withTenant } from '../db/tenant.ts';
import { decodeCursor, encodeCursor } from '../lib/pagination.ts';
import { scopeWith } from '../lib/scope.ts';

const ProductSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  sku: Type.Union([Type.String(), Type.Null()]),
  categoryName: Type.Union([Type.String(), Type.Null()]),
  storageCondition: Type.String(),
  isControlled: Type.Boolean(),
  reorderPoint: Type.Union([Type.Integer(), Type.Null()]),
  /** Summed across active batches — never stored twice. */
  quantityOnHand: Type.Integer(),
  batchCount: Type.Integer(),
  nearestExpiry: Type.Union([Type.String(), Type.Null()]),
});

export const productRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/api/products',
    {
      preHandler: app.requireOrg,
      schema: {
        querystring: Type.Object({
          q: Type.Optional(Type.String({ maxLength: 120 })),
          limit: Type.Integer({ minimum: 1, maximum: 200, default: 50 }),
          cursor: Type.Optional(Type.String({ maxLength: 200 })),
        }),
        response: {
          200: Type.Object({
            products: Type.Array(ProductSchema),
            nextCursor: Type.Union([Type.String(), Type.Null()]),
            hasMore: Type.Boolean(),
          }),
        },
      },
    },
    async (req) => {
      const scope = scopeWith(req, 'inventory.read');
      const { q, limit, cursor } = req.query;
      const after = cursor ? decodeCursor(cursor) : null;
      const afterName = typeof after?.[0] === 'string' ? after[0] : null;
      const afterId = typeof after?.[1] === 'string' ? after[1] : null;

      const rows = await withTenant(scope, async (tx) =>
        tx.execute<Record<string, unknown>>(raw`
          SELECT p.id, p.name, p.sku,
                 c.name AS "categoryName",
                 p.storage_condition AS "storageCondition",
                 p.is_controlled     AS "isControlled",
                 p.reorder_point     AS "reorderPoint",
                 COALESCE(SUM(b.quantity_on_hand) FILTER (WHERE b.status = 'active'), 0)::int
                   AS "quantityOnHand",
                 count(b.id) FILTER (WHERE b.status = 'active')::int AS "batchCount",
                 min(COALESCE(b.effective_expiry_date, b.expiry_date))
                   FILTER (WHERE b.status = 'active')::text AS "nearestExpiry"
            FROM product p
            LEFT JOIN product_category c ON c.id = p.category_id
            LEFT JOIN batch b ON b.product_id = p.id AND b.deleted_at IS NULL
           WHERE p.deleted_at IS NULL
             AND (${q ?? null}::text IS NULL OR p.name ILIKE '%' || ${q ?? null} || '%'
                                             OR p.sku  ILIKE '%' || ${q ?? null} || '%')
             AND (${afterName}::text IS NULL
                  OR (p.name, p.id) > (${afterName}::text, ${afterId}::uuid))
           GROUP BY p.id, c.name
           ORDER BY p.name, p.id
           LIMIT ${limit + 1}
        `),
      );

      const page = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      const last = page[page.length - 1];

      return {
        products: page as never,
        hasMore,
        nextCursor:
          hasMore && last ? encodeCursor([last['name'] as string, last['id'] as string]) : null,
      };
    },
  );

  app.post(
    '/api/products',
    {
      preHandler: app.requireOrg,
      schema: {
        body: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 200 }),
          sku: Type.Optional(Type.String({ maxLength: 64 })),
          barcode: Type.Optional(Type.String({ maxLength: 32 })),
          storageCondition: Type.Optional(
            Type.Union([
              Type.Literal('ambient'), Type.Literal('cold_chain'),
              Type.Literal('frozen'), Type.Literal('controlled_room'),
            ]),
          ),
          isControlled: Type.Optional(Type.Boolean()),
          reorderPoint: Type.Optional(Type.Integer({ minimum: 0 })),
          targetStockLevel: Type.Optional(Type.Integer({ minimum: 0 })),
        }),
        response: { 201: Type.Object({ id: Type.String(), name: Type.String() }) },
      },
    },
    async (req, reply) => {
      const scope = scopeWith(req, 'catalog.write');
      const b = req.body;

      const rows = await withTenant(scope, async (tx) =>
        tx.execute<{ id: string; name: string }>(raw`
          INSERT INTO product (
            organization_id, name, sku, barcode, storage_condition,
            is_controlled, reorder_point, target_stock_level, created_by
          ) VALUES (
            ${scope.organizationId}, ${b.name}, ${b.sku ?? null}, ${b.barcode ?? null},
            ${b.storageCondition ?? 'ambient'}, ${b.isControlled ?? false},
            ${b.reorderPoint ?? null}, ${b.targetStockLevel ?? null}, ${scope.userId}
          ) RETURNING id, name
        `),
      );
      return reply.code(201).send(rows[0]!);
    },
  );
};
