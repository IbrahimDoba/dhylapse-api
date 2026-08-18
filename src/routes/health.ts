import { sql as raw } from 'drizzle-orm';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { db } from '../db/client.ts';

export const healthRoutes: FastifyPluginAsyncTypebox = async (app) => {
  /** Liveness: is the process up? Deliberately does not touch the database. */
  app.get(
    '/health',
    {
      schema: {
        response: {
          200: Type.Object({ status: Type.Literal('ok'), uptime: Type.Number() }),
        },
      },
    },
    async () => ({ status: 'ok' as const, uptime: Math.round(process.uptime()) }),
  );

  /** Readiness: can we actually serve traffic? Used by the platform's health check. */
  app.get(
    '/health/ready',
    {
      schema: {
        response: {
          200: Type.Object({ status: Type.Literal('ready'), database: Type.Literal('up') }),
          503: Type.Object({ status: Type.Literal('degraded'), database: Type.String() }),
        },
      },
    },
    async (_req, reply) => {
      try {
        await db.execute(raw`SELECT 1`);
        return { status: 'ready' as const, database: 'up' as const };
      } catch (err) {
        _req.log.error({ err }, 'readiness check failed');
        return reply.code(503).send({ status: 'degraded' as const, database: 'unreachable' });
      }
    },
  );
};
