import { sql as raw } from 'drizzle-orm';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { withTenant } from '../db/tenant.ts';
import { AppError } from '../lib/errors.ts';
import { normalizeExpiry } from '../lib/expiry.ts';
import { decodeCursor, encodeCursor } from '../lib/pagination.ts';
import { scopeWith } from '../lib/scope.ts';
import type { TenantTx } from '../db/tenant.ts';

const BatchSchema = Type.Object({
  id: Type.String(),
  productId: Type.String(),
  productName: Type.String(),
  locationId: Type.String(),
  locationName: Type.String(),
  batchNumber: Type.Union([Type.String(), Type.Null()]),
  expiryDate: Type.String(),
  expiryPrecision: Type.String(),
  /** Earlier of the printed date and any post-opening shelf life. */
  effectiveExpiryDate: Type.String(),
  daysRemaining: Type.Integer(),
  quantityOnHand: Type.Integer(),
  status: Type.String(),
  unitCostMinor: Type.Union([Type.Integer(), Type.Null()]),
  valueAtRiskMinor: Type.Union([Type.Integer(), Type.Null()]),
});

/**
 * Days remaining is computed against CURRENT_DATE in the database, not a value
 * carried from the application. A server in one timezone and a pharmacy in
 * another must not disagree about what "today" is.
 */
const BATCH_SELECT = raw`
  SELECT b.id,
         b.product_id  AS "productId",  p.name AS "productName",
         b.location_id AS "locationId", l.name AS "locationName",
         b.batch_number AS "batchNumber",
         b.expiry_date::text AS "expiryDate",
         b.expiry_precision  AS "expiryPrecision",
         b.effective_expiry_date::text AS "effectiveExpiryDate",
         (b.effective_expiry_date - CURRENT_DATE)::int AS "daysRemaining",
         b.quantity_on_hand::int AS "quantityOnHand",
         b.status,
         b.unit_cost_minor::bigint AS "unitCostMinor",
         (b.unit_cost_minor * b.quantity_on_hand)::bigint AS "valueAtRiskMinor"
    FROM batch b
    JOIN product  p ON p.id = b.product_id
    JOIN location l ON l.id = b.location_id
`;

/** Resolves the target location, defaulting when the tenant only has one. */
async function resolveLocation(tx: TenantTx, requested?: string): Promise<string> {
  if (requested) {
    const rows = await tx.execute<{ id: string }>(
      raw`SELECT id FROM location WHERE id = ${requested} AND deleted_at IS NULL`,
    );
    if (!rows[0]) throw new AppError(422, 'invalid_reference', 'That location does not exist.');
    return rows[0].id;
  }

  const rows = await tx.execute<{ id: string }>(
    raw`SELECT id FROM location WHERE deleted_at IS NULL AND is_active ORDER BY created_at LIMIT 2`,
  );
  if (rows.length === 0) throw new AppError(422, 'no_location', 'This workspace has no location.');
  if (rows.length > 1) {
    throw new AppError(422, 'location_required', 'Specify locationId — this workspace has several.');
  }
  return rows[0]!.id;
}

export const batchRoutes: FastifyPluginAsyncTypebox = async (app) => {
  /**
   * Receive stock.
   *
   * The batch row is created with a zero balance and the quantity is applied as
   * a `receipt` movement, so the ledger is the only thing that ever moves stock.
   * Writing quantity_on_hand directly would leave a batch with no provenance.
   */
  app.post(
    '/api/batches',
    {
      preHandler: app.requireOrg,
      schema: {
        body: Type.Object({
          productId: Type.String({ format: 'uuid' }),
          locationId: Type.Optional(Type.String({ format: 'uuid' })),
          supplierId: Type.Optional(Type.String({ format: 'uuid' })),
          batchNumber: Type.Optional(Type.String({ maxLength: 64 })),
          /** YYYY-MM-DD, or YYYY-MM when the label prints only a month. */
          expiryDate: Type.String({ minLength: 7, maxLength: 10 }),
          quantity: Type.Integer({ minimum: 1 }),
          unitCostMinor: Type.Optional(Type.Integer({ minimum: 0 })),
          currency: Type.Optional(Type.String({ minLength: 3, maxLength: 3 })),
          notes: Type.Optional(Type.String({ maxLength: 1000 })),
        }),
        response: { 201: BatchSchema },
      },
    },
    async (req, reply) => {
      const scope = scopeWith(req, 'inventory.write');
      const b = req.body;
      const { expiryDate, precision } = normalizeExpiry(b.expiryDate);

      const batch = await withTenant(scope, async (tx) => {
        const locationId = await resolveLocation(tx, b.locationId);

        const created = await tx.execute<{ id: string }>(raw`
          INSERT INTO batch (
            organization_id, location_id, product_id, supplier_id, batch_number,
            expiry_date, expiry_precision, unit_cost_minor, currency,
            quantity_received, source_kind, notes, created_by
          ) VALUES (
            ${scope.organizationId}, ${locationId}, ${b.productId}, ${b.supplierId ?? null},
            ${b.batchNumber ?? null}, ${expiryDate}::date, ${precision},
            ${b.unitCostMinor ?? null}, ${b.currency ?? null},
            ${b.quantity}, 'manual', ${b.notes ?? null}, ${scope.userId}
          ) RETURNING id
        `);
        const batchId = created[0]!.id;

        await tx.execute(raw`
          INSERT INTO stock_movement (
            organization_id, location_id, batch_id, product_id,
            quantity_delta, balance_after, reason, unit_cost_minor, currency, actor_id
          ) VALUES (
            ${scope.organizationId}, ${locationId}, ${batchId}, ${b.productId},
            ${b.quantity}, 0, 'receipt', ${b.unitCostMinor ?? null},
            ${b.currency ?? null}, ${scope.userId}
          )
        `);

        const rows = await tx.execute<Record<string, unknown>>(
          raw`${BATCH_SELECT} WHERE b.id = ${batchId}`,
        );
        return rows[0];
      });

      return reply.code(201).send(batch as never);
    },
  );

  /** Inventory list, ordered first-expiring-first. */
  app.get(
    '/api/batches',
    {
      preHandler: app.requireOrg,
      schema: {
        querystring: Type.Object({
          locationId: Type.Optional(Type.String({ format: 'uuid' })),
          productId: Type.Optional(Type.String({ format: 'uuid' })),
          /** Matches product name, SKU, or lot number. */
          q: Type.Optional(Type.String({ maxLength: 120 })),
          /** Only batches expiring within this many days. */
          withinDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 3650 })),
          includeDepleted: Type.Boolean({ default: false }),
          limit: Type.Integer({ minimum: 1, maximum: 200, default: 50 }),
          cursor: Type.Optional(Type.String({ maxLength: 200 })),
        }),
        response: {
          200: Type.Object({
            batches: Type.Array(BatchSchema),
            nextCursor: Type.Union([Type.String(), Type.Null()]),
            hasMore: Type.Boolean(),
          }),
        },
      },
    },
    async (req) => {
      const scope = scopeWith(req, 'inventory.read');
      const { locationId, productId, withinDays, includeDepleted, limit, cursor, q } = req.query;
      const after = cursor ? decodeCursor(cursor) : null;
      const afterDate = typeof after?.[0] === 'string' ? after[0] : null;
      const afterId = typeof after?.[1] === 'string' ? after[1] : null;

      const rows = await withTenant(scope, async (tx) =>
        tx.execute<Record<string, unknown>>(raw`
          ${BATCH_SELECT}
           WHERE b.deleted_at IS NULL
             AND (${includeDepleted} OR b.status = 'active')
             AND (${locationId ?? null}::uuid IS NULL OR b.location_id = ${locationId ?? null}::uuid)
             AND (${productId ?? null}::uuid  IS NULL OR b.product_id  = ${productId ?? null}::uuid)
             AND (${q ?? null}::text IS NULL
                  OR p.name        ILIKE '%' || ${q ?? null} || '%'
                  OR p.sku         ILIKE '%' || ${q ?? null} || '%'
                  OR b.batch_number ILIKE '%' || ${q ?? null} || '%')
             AND (${withinDays ?? null}::int IS NULL
                  OR b.effective_expiry_date
                     <= CURRENT_DATE + (${withinDays ?? 0}::int * INTERVAL '1 day'))
             AND (${afterDate}::date IS NULL
                  OR (b.effective_expiry_date, b.id)
                     > (${afterDate}::date, ${afterId}::uuid))
           ORDER BY b.effective_expiry_date, b.id
           LIMIT ${limit + 1}
        `),
      );

      const page = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      const last = page[page.length - 1];

      return {
        batches: page as never,
        hasMore,
        nextCursor: hasMore && last
          ? encodeCursor([last['effectiveExpiryDate'] as string, last['id'] as string])
          : null,
      };
    },
  );

  /**
   * Correct a balance. Always a compensating ledger entry, never an edit — the
   * ledger is append-only and a correction must leave a trail of its own.
   */
  app.post(
    '/api/batches/:id/adjust',
    {
      preHandler: app.requireOrg,
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        body: Type.Object({
          /** Signed. Negative removes stock. */
          quantityDelta: Type.Integer(),
          reason: Type.Union([
            Type.Literal('adjustment'), Type.Literal('damage'),
            Type.Literal('dispense'), Type.Literal('stock_count'),
          ]),
          notes: Type.Optional(Type.String({ maxLength: 1000 })),
        }),
        response: { 200: BatchSchema },
      },
    },
    async (req) => {
      const scope = scopeWith(req, 'inventory.adjust');
      const { id } = req.params;
      const { quantityDelta, reason, notes } = req.body;

      if (quantityDelta === 0) {
        throw new AppError(422, 'invalid_state', 'An adjustment must change the quantity.');
      }

      return withTenant(scope, async (tx) => {
        const found = await tx.execute<{ locationId: string; productId: string }>(raw`
          SELECT location_id AS "locationId", product_id AS "productId"
            FROM batch WHERE id = ${id} AND deleted_at IS NULL
        `);
        if (!found[0]) throw new AppError(404, 'not_found', 'Batch not found.');

        await tx.execute(raw`
          INSERT INTO stock_movement (
            organization_id, location_id, batch_id, product_id,
            quantity_delta, balance_after, reason, notes, actor_id
          ) VALUES (
            ${scope.organizationId}, ${found[0].locationId}, ${id}, ${found[0].productId},
            ${quantityDelta}, 0, ${reason}, ${notes ?? null}, ${scope.userId}
          )
        `);

        const rows = await tx.execute<Record<string, unknown>>(
          raw`${BATCH_SELECT} WHERE b.id = ${id}`,
        );
        return rows[0] as never;
      });
    },
  );

  /** Full movement history for one batch — the audit answer to "why is it this number?". */
  app.get(
    '/api/batches/:id/movements',
    {
      preHandler: app.requireOrg,
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: {
          200: Type.Object({
            movements: Type.Array(
              Type.Object({
                id: Type.String(),
                quantityDelta: Type.Integer(),
                balanceAfter: Type.Integer(),
                reason: Type.String(),
                notes: Type.Union([Type.String(), Type.Null()]),
                occurredAt: Type.String(),
                actorName: Type.Union([Type.String(), Type.Null()]),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const scope = scopeWith(req, 'inventory.read');
      const movements = await withTenant(scope, async (tx) =>
        tx.execute<Record<string, unknown>>(raw`
          SELECT m.id,
                 m.quantity_delta::int AS "quantityDelta",
                 m.balance_after::int  AS "balanceAfter",
                 m.reason, m.notes,
                 m.occurred_at::text   AS "occurredAt",
                 u.name                AS "actorName"
            FROM stock_movement m
            LEFT JOIN app_user u ON u.id = m.actor_id
           WHERE m.batch_id = ${req.params.id}
           ORDER BY m.occurred_at, m.id
        `),
      );
      return { movements: [...movements] as never };
    },
  );
};
