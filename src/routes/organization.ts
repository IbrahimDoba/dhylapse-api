import { sql as raw } from 'drizzle-orm';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { withTenant } from '../db/tenant.ts';
import { scopeWith } from '../lib/scope.ts';

export const organizationRoutes: FastifyPluginAsyncTypebox = async (app) => {
  /** The pharmacy workspace itself: profile, locations, plan. */
  app.get(
    '/api/workspace',
    {
      preHandler: app.requireOrg,
      schema: {
        response: {
          200: Type.Object({
            id: Type.String(),
            name: Type.String(),
            slug: Type.String(),
            timezone: Type.String(),
            currency: Type.String(),
            countryCode: Type.String(),
            planCode: Type.String(),
            billingStatus: Type.String(),
            createdAt: Type.String(),
            locations: Type.Array(
              Type.Object({
                id: Type.String(),
                name: Type.String(),
                code: Type.String(),
                kind: Type.String(),
                isActive: Type.Boolean(),
                batchCount: Type.Integer(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const scope = scopeWith(req, 'inventory.read');
      return withTenant(scope, async (tx) => {
        const [org] = await tx.execute<Record<string, string>>(raw`
          SELECT id, name, slug, timezone,
                 default_currency AS currency, country_code AS "countryCode",
                 plan_code AS "planCode", billing_status AS "billingStatus",
                 created_at::text AS "createdAt"
            FROM organization LIMIT 1`);

        const locations = await tx.execute<Record<string, unknown>>(raw`
          SELECT l.id, l.name, l.code, l.kind, l.is_active AS "isActive",
                 count(b.id) FILTER (WHERE b.status = 'active')::int AS "batchCount"
            FROM location l
            LEFT JOIN batch b ON b.location_id = l.id AND b.deleted_at IS NULL
           WHERE l.deleted_at IS NULL
           GROUP BY l.id ORDER BY l.name`);

        return { ...org, locations: [...locations] } as never;
      });
    },
  );

  /** Everyone with access to this workspace. */
  app.get(
    '/api/staff',
    {
      preHandler: app.requireOrg,
      schema: {
        response: {
          200: Type.Object({
            staff: Type.Array(
              Type.Object({
                membershipId: Type.String(),
                userId: Type.String(),
                name: Type.String(),
                email: Type.String(),
                role: Type.String(),
                status: Type.String(),
                allLocations: Type.Boolean(),
                joinedAt: Type.String(),
                isYou: Type.Boolean(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const scope = scopeWith(req, 'inventory.read');
      const staff = await withTenant(scope, async (tx) =>
        tx.execute<Record<string, unknown>>(raw`
          SELECT m.id AS "membershipId", u.id AS "userId", u.name, u.email,
                 m.role, m.status, m.all_locations AS "allLocations",
                 m.created_at::text AS "joinedAt",
                 (u.id = ${scope.userId}::uuid) AS "isYou"
            FROM membership m
            JOIN app_user u ON u.id = m.user_id
           WHERE m.deleted_at IS NULL
           ORDER BY
             CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1
                         WHEN 'pharmacist' THEN 2 WHEN 'staff' THEN 3 ELSE 4 END,
             u.name`),
      );
      return { staff: [...staff] } as never;
    },
  );

  /** The configured expiry ladder. Alert *events* arrive with the scan engine. */
  app.get(
    '/api/alert-rules',
    {
      preHandler: app.requireOrg,
      schema: {
        response: {
          200: Type.Object({
            rules: Type.Array(
              Type.Object({
                id: Type.String(),
                name: Type.String(),
                kind: Type.String(),
                thresholdDays: Type.Union([Type.Integer(), Type.Null()]),
                severity: Type.Integer(),
                channels: Type.Array(Type.String()),
                cadence: Type.String(),
                isEnabled: Type.Boolean(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const scope = scopeWith(req, 'inventory.read');
      const rules = await withTenant(scope, async (tx) =>
        tx.execute<Record<string, unknown>>(raw`
          SELECT id, name, kind, threshold_days AS "thresholdDays", severity,
                 channels, cadence, is_enabled AS "isEnabled"
            FROM alert_rule
           WHERE deleted_at IS NULL
           ORDER BY severity, threshold_days NULLS LAST`),
      );
      return { rules: [...rules] } as never;
    },
  );
};
