import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { auth } from '../auth/config.ts';
import { type AuthContext, loadMemberships, resolveActiveOrg } from '../auth/context.ts';
import { AppError } from '../lib/errors.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated when the request carries a valid session. */
    auth?: AuthContext;
  }
  interface FastifyInstance {
    /** preHandler that rejects anonymous requests. */
    requireAuth: (req: FastifyRequest) => Promise<void>;
    /** preHandler that additionally requires a selected organization. */
    requireOrg: (req: FastifyRequest) => Promise<void>;
  }
}

/** Fastify's request shape -> the web `Request` better-auth's handler expects. */
function toWebRequest(req: FastifyRequest, baseUrl: string): Request {
  const url = new URL(req.url, baseUrl);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.append(key, String(value));
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method,
    headers,
    ...(hasBody && req.body ? { body: JSON.stringify(req.body) } : {}),
  });
}

const authPlugin: FastifyPluginAsync = async (app) => {
  const baseUrl = `${app.initialConfig.https ? 'https' : 'http'}://localhost`;

  /** Mount better-auth's own endpoints: /api/auth/sign-up, /sign-in, /callback/google, … */
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (req, reply) => {
      const response = await auth.handler(toWebRequest(req, baseUrl));
      reply.status(response.status);
      // Multiple Set-Cookie headers must survive the hop, so use getSetCookie().
      for (const [key, value] of response.headers.entries()) {
        if (key.toLowerCase() !== 'set-cookie') reply.header(key, value);
      }
      const cookies = response.headers.getSetCookie?.() ?? [];
      if (cookies.length > 0) reply.header('set-cookie', cookies);
      return reply.send(response.body ? await response.text() : null);
    },
  });

  /**
   * Attach identity to every request. Never rejects — routes opt in to
   * requiring auth, so public endpoints stay public.
   */
  app.addHook('onRequest', async (req) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) headers.append(k, Array.isArray(v) ? v.join(',') : String(v));
    }

    const session = await auth.api.getSession({ headers }).catch(() => null);
    if (!session?.user) return;

    const memberships = await loadMemberships(session.user.id);
    const requested = req.headers['x-organization-id'];

    req.auth = {
      userId: session.user.id,
      email: session.user.email,
      name: session.user.name,
      memberships,
      activeOrganizationId: resolveActiveOrg(
        memberships,
        typeof requested === 'string' ? requested : undefined,
      ),
    };
  });

  app.decorate('requireAuth', async (req: FastifyRequest) => {
    if (!req.auth) throw new AppError(401, 'unauthenticated', 'Sign in to continue.');
  });

  app.decorate('requireOrg', async (req: FastifyRequest) => {
    if (!req.auth) throw new AppError(401, 'unauthenticated', 'Sign in to continue.');
    if (!req.auth.activeOrganizationId) {
      throw new AppError(
        403,
        'no_organization',
        req.auth.memberships.length === 0
          ? 'You do not belong to a pharmacy workspace yet.'
          : 'Choose a workspace with the X-Organization-Id header.',
      );
    }
  });
};

export default fp(authPlugin, { name: 'auth' });
