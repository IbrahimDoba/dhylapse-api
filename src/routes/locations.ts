import { sql as raw } from 'drizzle-orm';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { withTenant } from '../db/tenant.ts';
import { scopeWith } from '../lib/scope.ts';

export const locationRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/api/locations',
    {
      preHandler: app.requireOrg,
      schema: {
        response: {
          200: Type.Object({
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
      const locations = await withTenant(scope, async (tx) =>
        tx.execute<{
          id: string; name: string; code: string; kind: string;
          isActive: boolean; batchCount: number;
        }>(raw`
          SELECT l.id, l.name, l.code, l.kind, l.is_active AS "isActive",
                 count(b.id) FILTER (WHERE b.status = 'active')::int AS "batchCount"
            FROM location l
            LEFT JOIN batch b ON b.location_id = l.id AND b.deleted_at IS NULL
           WHERE l.deleted_at IS NULL
           GROUP BY l.id
           ORDER BY l.name
        `),
      );
      return { locations: [...locations] };
    },
  );
};
