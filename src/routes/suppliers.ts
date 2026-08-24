import { sql as raw } from 'drizzle-orm';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { withTenant } from '../db/tenant.ts';
import { scopeWith } from '../lib/scope.ts';

const SupplierSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  code: Type.Union([Type.String(), Type.Null()]),
  email: Type.Union([Type.String(), Type.Null()]),
  phone: Type.Union([Type.String(), Type.Null()]),
  acceptsReturns: Type.Boolean(),
  returnWindowDaysBeforeExpiry: Type.Union([Type.Integer(), Type.Null()]),
  creditRatePercent: Type.Union([Type.Integer(), Type.Null()]),
  returnPolicyNotes: Type.Union([Type.String(), Type.Null()]),
  isActive: Type.Boolean(),
  batchCount: Type.Integer(),
});

export const supplierRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/api/suppliers',
    {
      preHandler: app.requireOrg,
      schema: { response: { 200: Type.Object({ suppliers: Type.Array(SupplierSchema) }) } },
    },
    async (req) => {
      const scope = scopeWith(req, 'inventory.read');
      const suppliers = await withTenant(scope, (tx) =>
        tx.execute<Record<string, unknown>>(raw`
          SELECT s.id, s.name, s.code, s.email, s.phone,
                 s.accepts_returns AS "acceptsReturns",
                 s.return_window_days_before_expiry AS "returnWindowDaysBeforeExpiry",
                 s.credit_rate_percent AS "creditRatePercent",
                 s.return_policy_notes AS "returnPolicyNotes",
                 s.is_active AS "isActive",
                 count(b.id) FILTER (WHERE b.status = 'active')::int AS "batchCount"
            FROM supplier s
            LEFT JOIN batch b ON b.supplier_id = s.id AND b.deleted_at IS NULL
           WHERE s.deleted_at IS NULL
           GROUP BY s.id ORDER BY s.name`),
      );
      return { suppliers: [...suppliers] } as never;
    },
  );

  app.post(
    '/api/suppliers',
    {
      preHandler: app.requireOrg,
      schema: {
        body: Type.Object({
          name: Type.String({ minLength: 1, maxLength: 200 }),
          code: Type.Optional(Type.String({ maxLength: 32 })),
          email: Type.Optional(Type.String({ maxLength: 200 })),
          phone: Type.Optional(Type.String({ maxLength: 32 })),
          /**
           * The terms that decide whether expiring stock is recoverable value
           * or a write-off. Surfacing "returnable until 90 days before expiry"
           * next to an alert is the difference between a warning and a saved
           * sale, so these are first-class fields rather than a notes blob.
           */
          acceptsReturns: Type.Optional(Type.Boolean()),
          returnWindowDaysBeforeExpiry: Type.Optional(Type.Integer({ minimum: 0, maximum: 3650 })),
          creditRatePercent: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
          returnPolicyNotes: Type.Optional(Type.String({ maxLength: 2000 })),
        }),
        response: { 201: Type.Object({ id: Type.String(), name: Type.String() }) },
      },
    },
    async (req, reply) => {
      const scope = scopeWith(req, 'catalog.write');
      const b = req.body;
      const rows = await withTenant(scope, (tx) =>
        tx.execute<{ id: string; name: string }>(raw`
          INSERT INTO supplier (
            organization_id, name, code, email, phone, accepts_returns,
            return_window_days_before_expiry, credit_rate_percent,
            return_policy_notes, created_by
          ) VALUES (
            ${scope.organizationId}, ${b.name}, ${b.code ?? null}, ${b.email ?? null},
            ${b.phone ?? null}, ${b.acceptsReturns ?? false},
            ${b.returnWindowDaysBeforeExpiry ?? null}, ${b.creditRatePercent ?? null},
            ${b.returnPolicyNotes ?? null}, ${scope.userId}
          ) RETURNING id, name`),
      );
      return reply.code(201).send(rows[0]!);
    },
  );
};
