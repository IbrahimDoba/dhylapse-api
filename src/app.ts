import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { env } from './env.ts';
import { toHttpError } from './lib/errors.ts';
import authPlugin from './plugins/auth.ts';
import { healthRoutes } from './routes/health.ts';
import { batchRoutes } from './routes/batches.ts';
import { locationRoutes } from './routes/locations.ts';
import { productRoutes } from './routes/products.ts';
import { workspaceRoutes } from './routes/workspace.ts';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Pretty output locally; JSON in production so the platform can index it.
      ...(env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
        : {}),
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    // Trust the platform's proxy so client IPs and protocol are accurate on
    // Railway/Render/Fly, where every request arrives via their edge.
    trustProxy: true,
    disableRequestLogging: false,
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
    ajv: { customOptions: { removeAdditional: 'all', coerceTypes: 'array' } },
  }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(sensible);
  await app.register(cors, {
    origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',').map((s) => s.trim()),
    credentials: true,
  });

  /**
   * One error handler for everything. Database constraint violations are
   * translated into useful messages; anything unrecognised is logged in full
   * and returned as a bare 500, so internal detail never reaches a client.
   */
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const mapped = toHttpError(err);

    if (mapped) {
      req.log.warn({ err, code: mapped.code, detail: mapped.detail }, 'request rejected');
      return reply.code(mapped.statusCode).send({
        error: mapped.code,
        message: mapped.message,
        requestId: req.id,
      });
    }

    // Fastify's own validation errors arrive with a statusCode already set.
    if (err.validation) {
      return reply.code(400).send({
        error: 'validation_failed',
        message: err.message,
        requestId: req.id,
      });
    }

    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({
        error: err.code ?? 'request_error',
        message: err.message,
        requestId: req.id,
      });
    }

    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({
      error: 'internal_error',
      message: 'Something went wrong on our side.',
      requestId: req.id,
    });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: 'not_found', message: 'Not found.', requestId: req.id }),
  );

  await app.register(authPlugin);

  await app.register(healthRoutes);
  await app.register(workspaceRoutes);
  await app.register(locationRoutes);
  await app.register(productRoutes);
  await app.register(batchRoutes);

  return app;
}
