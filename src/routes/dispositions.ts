import { sql as raw } from 'drizzle-orm';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { withTenant } from '../db/tenant.ts';
import { AppError } from '../lib/errors.ts';
import { scopeWith } from '../lib/scope.ts';

/**
 * What was decided about at-risk stock, and what it was worth.
 *
 * This is the half of the product that recovers money rather than reporting
 * loss. An expiry alert on its own tells a pharmacy something bad is coming;
 * a disposition records what they did about it and how much came back.
 *
 * Lifecycle: proposed -> approved -> completed. Only completion moves stock,
 * and it moves it through the ledger like everything else.
 */

const ACTIONS = [
  'return_to_supplier', 'destroy', 'discount', 'donate', 'transfer', 'write_off',
] as const;

/**
 * A discount is a pricing decision, not a stock movement — the units leave
 * later, through ordinary dispensing. Everything else physically removes them.
 */
const REMOVES_STOCK: Record<string, string | null> = {
  return_to_supplier: 'return_to_supplier',
  destroy: 'disposal',
  donate: 'disposal',
  write_off: 'expiry_writeoff',
  transfer: 'transfer_out',
  discount: null,
};

const DispositionSchema = Type.Object({
  id: Type.String(),
  reference: Type.String(),
  action: Type.String(),
  status: Type.String(),
  quantity: Type.Integer(),
  productName: Type.String(),
  batchNumber: Type.Union([Type.String(), Type.Null()]),
  expiryDate: Type.Union([Type.String(), Type.Null()]),
  supplierName: Type.Union([Type.String(), Type.Null()]),
  costValueMinor: Type.Union([Type.Integer(), Type.Null()]),
  recoveredValueMinor: Type.Union([Type.Integer(), Type.Null()]),
  creditNoteReference: Type.Union([Type.String(), Type.Null()]),
  creditReceivedAt: Type.Union([Type.String(), Type.Null()]),
  reason: Type.Union([Type.String(), Type.Null()]),
  proposedBy: Type.Union([Type.String(), Type.Null()]),
  approvedBy: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});

const SELECT_DISPOSITION = raw`
  SELECT d.id, d.reference, d.action, d.status, d.quantity::int AS quantity,
         p.name AS "productName", b.batch_number AS "batchNumber",
         b.effective_expiry_date::text AS "expiryDate",
         s.name AS "supplierName",
         d.cost_value_minor::int      AS "costValueMinor",
         d.recovered_value_minor::int AS "recoveredValueMinor",
         d.credit_note_reference      AS "creditNoteReference",
         d.credit_received_at::text   AS "creditReceivedAt",
         d.reason,
         pu.name AS "proposedBy", au.name AS "approvedBy",
         d.created_at::text AS "createdAt"
    FROM disposition d
    JOIN product  p ON p.id = d.product_id
    JOIN batch    b ON b.id = d.batch_id
    LEFT JOIN supplier s  ON s.id = d.supplier_id
    LEFT JOIN app_user pu ON pu.id = d.proposed_by
    LEFT JOIN app_user au ON au.id = d.approved_by
`;

export const dispositionRoutes: FastifyPluginAsyncTypebox = async (app) => {
  /**
   * What can be done with a batch, and what it is worth.
   *
   * Answers the question an alert raises but cannot itself resolve: is this
   * returnable, and for how much? The supplier's return window is the whole
   * point — a lot 40 days from expiry with a 90-day window has already missed
   * it, and telling someone that before they waste a phone call is the value.
   */
  app.get(
    '/api/batches/:id/options',
    {
      preHandler: app.requireOrg,
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: {
          200: Type.Object({
            batchId: Type.String(),
            quantityOnHand: Type.Integer(),
            daysRemaining: Type.Integer(),
            costValueMinor: Type.Union([Type.Integer(), Type.Null()]),
            supplier: Type.Union([
              Type.Object({
                id: Type.String(),
                name: Type.String(),
                acceptsReturns: Type.Boolean(),
                returnWindowDaysBeforeExpiry: Type.Union([Type.Integer(), Type.Null()]),
                creditRatePercent: Type.Union([Type.Integer(), Type.Null()]),
              }),
              Type.Null(),
            ]),
            returnable: Type.Boolean(),
            returnWindowClosed: Type.Boolean(),
            estimatedCreditMinor: Type.Union([Type.Integer(), Type.Null()]),
            recommendation: Type.String(),
          }),
        },
      },
    },
    async (req) => {
      const scope = scopeWith(req, 'inventory.read');
      return withTenant(scope, async (tx) => {
        const [row] = await tx.execute<Record<string, unknown>>(raw`
          SELECT b.id, b.quantity_on_hand::int AS qty,
                 (b.effective_expiry_date - CURRENT_DATE)::int AS days,
                 (b.unit_cost_minor * b.quantity_on_hand)::int AS cost,
                 s.id AS sid, s.name AS sname,
                 s.accepts_returns AS accepts,
                 s.return_window_days_before_expiry AS window,
                 s.credit_rate_percent AS rate
            FROM batch b
            LEFT JOIN supplier s ON s.id = b.supplier_id AND s.deleted_at IS NULL
           WHERE b.id = ${req.params.id} AND b.deleted_at IS NULL`);
        if (!row) throw new AppError(404, 'not_found', 'Batch not found.');

        const days = Number(row['days']);
        const cost = row['cost'] == null ? null : Number(row['cost']);
        const accepts = row['accepts'] === true;
        const window = row['window'] == null ? null : Number(row['window']);
        const rate = row['rate'] == null ? null : Number(row['rate']);

        // Inside the window means there are still at least `window` days left.
        const windowClosed = accepts && window != null && days < window;
        const returnable = accepts && !windowClosed && days >= 0;
        const estimatedCredit =
          returnable && cost != null ? Math.round((cost * (rate ?? 100)) / 100) : null;

        /*
         * Expired is checked before the return window, because they call for
         * different actions and the window test is trivially true once a date
         * has passed. Telling someone to "discount or dispose" stock that
         * expired last week is wrong advice — it has to be destroyed, with
         * evidence.
         */
        const supplierName = String(row['sname'] ?? '');
        const recommendation = !row['sid']
          ? 'No supplier recorded for this batch — add one to see whether it can be returned.'
          : days < 0
            ? 'Already expired. Suppliers do not credit expired stock — destroy it and keep the certificate.'
            : returnable
              ? `Returnable to ${supplierName}${estimatedCredit != null ? ' for an estimated credit' : ''}.`
              : windowClosed
                ? `Past the ${window}-day return window for ${supplierName} — discount to clear, or dispose.`
                : `${supplierName} does not accept returns — discount to clear, or dispose.`;

        return {
          batchId: String(row['id']),
          quantityOnHand: Number(row['qty']),
          daysRemaining: days,
          costValueMinor: cost,
          supplier: row['sid']
            ? {
                id: String(row['sid']),
                name: String(row['sname']),
                acceptsReturns: accepts,
                returnWindowDaysBeforeExpiry: window,
                creditRatePercent: rate,
              }
            : null,
          returnable,
          returnWindowClosed: windowClosed,
          estimatedCreditMinor: estimatedCredit,
          recommendation,
        };
      });
    },
  );

  app.get(
    '/api/dispositions',
    {
      preHandler: app.requireOrg,
      schema: {
        querystring: Type.Object({
          status: Type.Optional(Type.String({ maxLength: 20 })),
          limit: Type.Integer({ minimum: 1, maximum: 200, default: 50 }),
        }),
        response: {
          200: Type.Object({
            dispositions: Type.Array(DispositionSchema),
            summary: Type.Object({
              proposed: Type.Integer(),
              completed: Type.Integer(),
              costValueMinor: Type.Integer(),
              recoveredValueMinor: Type.Integer(),
              pendingCreditMinor: Type.Integer(),
            }),
          }),
        },
      },
    },
    async (req) => {
      const scope = scopeWith(req, 'inventory.read');
      return withTenant(scope, async (tx) => {
        const dispositions = await tx.execute<Record<string, unknown>>(raw`
          ${SELECT_DISPOSITION}
           WHERE d.deleted_at IS NULL
             AND (${req.query.status ?? null}::text IS NULL OR d.status = ${req.query.status ?? null}::text)
           ORDER BY d.created_at DESC LIMIT ${req.query.limit}`);

        const [summary] = await tx.execute<Record<string, number>>(raw`
          SELECT count(*) FILTER (WHERE status = 'proposed')::int  AS proposed,
                 count(*) FILTER (WHERE status = 'completed')::int AS completed,
                 COALESCE(SUM(cost_value_minor) FILTER (WHERE status = 'completed'), 0)::int      AS "costValueMinor",
                 COALESCE(SUM(recovered_value_minor) FILTER (WHERE status = 'completed'), 0)::int AS "recoveredValueMinor",
                 -- Money the supplier owes but has not paid: the follow-up list.
                 COALESCE(SUM(recovered_value_minor) FILTER (
                   WHERE action = 'return_to_supplier' AND credit_received_at IS NULL
                 ), 0)::int AS "pendingCreditMinor"
            FROM disposition WHERE deleted_at IS NULL`);

        return { dispositions: [...dispositions], summary } as never;
      });
    },
  );

  /** Propose. Records the decision; moves nothing. */
  app.post(
    '/api/dispositions',
    {
      preHandler: app.requireOrg,
      schema: {
        body: Type.Object({
          batchId: Type.String({ format: 'uuid' }),
          action: Type.Union(ACTIONS.map((a) => Type.Literal(a))),
          quantity: Type.Integer({ minimum: 1 }),
          supplierId: Type.Optional(Type.String({ format: 'uuid' })),
          reason: Type.Optional(Type.String({ maxLength: 1000 })),
        }),
        response: { 201: DispositionSchema },
      },
    },
    async (req, reply) => {
      const scope = scopeWith(req, 'inventory.write');
      const b = req.body;

      return withTenant(scope, async (tx) => {
        const [batch] = await tx.execute<Record<string, unknown>>(raw`
          SELECT id, location_id, product_id, supplier_id,
                 quantity_on_hand::int AS qty, unit_cost_minor::int AS cost, currency
            FROM batch WHERE id = ${b.batchId} AND deleted_at IS NULL`);
        if (!batch) throw new AppError(404, 'not_found', 'Batch not found.');

        if (b.quantity > Number(batch['qty'])) {
          throw new AppError(
            422,
            'invalid_state',
            `Only ${batch['qty']} units on hand; cannot dispose of ${b.quantity}.`,
          );
        }

        const unitCost = batch['cost'] == null ? null : Number(batch['cost']);
        const [created] = await tx.execute<{ id: string }>(raw`
          INSERT INTO disposition (
            organization_id, location_id, batch_id, product_id, supplier_id,
            reference, action, status, quantity, cost_value_minor, currency,
            reason, proposed_by, created_by
          ) VALUES (
            ${scope.organizationId}, ${batch['location_id']}, ${b.batchId}, ${batch['product_id']},
            ${b.supplierId ?? batch['supplier_id'] ?? null},
            'DSP-' || to_char(now(), 'YYMMDD') || '-' || lpad((
              SELECT (count(*) + 1)::text FROM disposition
               WHERE created_at::date = CURRENT_DATE
            ), 4, '0'),
            ${b.action}, 'proposed', ${b.quantity},
            ${unitCost == null ? null : unitCost * b.quantity},
            ${batch['currency'] ?? null}, ${b.reason ?? null}, ${scope.userId}, ${scope.userId}
          ) RETURNING id`);

        const [row] = await tx.execute<Record<string, unknown>>(
          raw`${SELECT_DISPOSITION} WHERE d.id = ${created!.id}`,
        );
        return reply.code(201).send(row as never);
      });
    },
  );

  app.post(
    '/api/dispositions/:id/approve',
    {
      preHandler: app.requireOrg,
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: { 200: DispositionSchema },
      },
    },
    async (req) => {
      // Separate from proposing on purpose: writing off stock is the
      // abuse-prone action, so counter staff can raise it and cannot approve it.
      const scope = scopeWith(req, 'disposal.approve');
      return withTenant(scope, async (tx) => {
        const [updated] = await tx.execute<{ id: string }>(raw`
          UPDATE disposition
             SET status = 'approved', approved_by = ${scope.userId}, approved_at = now()
           WHERE id = ${req.params.id} AND status = 'proposed'
          RETURNING id`);
        if (!updated) throw new AppError(404, 'not_found', 'Not found, or no longer awaiting approval.');
        const [row] = await tx.execute<Record<string, unknown>>(
          raw`${SELECT_DISPOSITION} WHERE d.id = ${req.params.id}`,
        );
        return row as never;
      });
    },
  );

  /** Complete it: this is the step that moves stock and records what came back. */
  app.post(
    '/api/dispositions/:id/complete',
    {
      preHandler: app.requireOrg,
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        body: Type.Object({
          recoveredValueMinor: Type.Optional(Type.Integer({ minimum: 0 })),
          creditNoteReference: Type.Optional(Type.String({ maxLength: 64 })),
          certificateReference: Type.Optional(Type.String({ maxLength: 64 })),
          creditReceived: Type.Optional(Type.Boolean()),
        }),
        response: { 200: DispositionSchema },
      },
    },
    async (req) => {
      const scope = scopeWith(req, 'disposal.approve');
      const b = req.body;

      return withTenant(scope, async (tx) => {
        const [d] = await tx.execute<Record<string, unknown>>(raw`
          SELECT id, status, action, quantity::int AS quantity,
                 batch_id, product_id, location_id
            FROM disposition WHERE id = ${req.params.id} AND deleted_at IS NULL FOR UPDATE`);
        if (!d) throw new AppError(404, 'not_found', 'Disposition not found.');
        if (d['status'] !== 'approved') {
          throw new AppError(422, 'invalid_state', `Must be approved first (currently ${String(d['status'])}).`);
        }

        const movementReason = REMOVES_STOCK[String(d['action'])];
        if (movementReason) {
          // Through the ledger, like every other quantity change. The trigger
          // rejects it if the stock is no longer there.
          await tx.execute(raw`
            INSERT INTO stock_movement (
              organization_id, location_id, batch_id, product_id,
              quantity_delta, balance_after, reason, actor_id, reference_type, reference_id, notes
            ) VALUES (
              ${scope.organizationId}, ${d['location_id']}, ${d['batch_id']}, ${d['product_id']},
              ${-Number(d['quantity'])}, 0, ${movementReason}, ${scope.userId},
              'disposition', ${d['id']}, ${'Disposition ' + String(d['action'])}
            )`);
        }

        await tx.execute(raw`
          UPDATE disposition
             SET status = 'completed',
                 completed_at = now(),
                 recovered_value_minor = ${b.recoveredValueMinor ?? 0},
                 credit_note_reference  = ${b.creditNoteReference ?? null},
                 certificate_reference  = ${b.certificateReference ?? null},
                 credit_received_at = ${b.creditReceived ? raw`now()` : raw`NULL`}
           WHERE id = ${req.params.id}`);

        const [row] = await tx.execute<Record<string, unknown>>(
          raw`${SELECT_DISPOSITION} WHERE d.id = ${req.params.id}`,
        );
        return row as never;
      });
    },
  );
};
