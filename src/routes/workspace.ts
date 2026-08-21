import { randomBytes } from 'node:crypto';
import { sql as raw } from 'drizzle-orm';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { loadMemberships } from '../auth/context.ts';
import { withTenant, withUser } from '../db/tenant.ts';
import { AppError } from '../lib/errors.ts';

const MembershipSchema = Type.Object({
  organizationId: Type.String(),
  organizationName: Type.String(),
  organizationSlug: Type.String(),
  role: Type.String(),
  permissions: Type.Array(Type.String()),
  allLocations: Type.Boolean(),
});

/** "Greenline Pharmacy Ltd." -> "greenline-pharmacy-ltd" */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'workspace';
}

export const workspaceRoutes: FastifyPluginAsyncTypebox = async (app) => {
  /** Who am I, and which workspaces can I act for? */
  app.get(
    '/api/me',
    {
      preHandler: app.requireAuth,
      schema: {
        response: {
          200: Type.Object({
            userId: Type.String(),
            email: Type.String(),
            name: Type.String(),
            activeOrganizationId: Type.Union([Type.String(), Type.Null()]),
            memberships: Type.Array(MembershipSchema),
          }),
        },
      },
    },
    async (req) => ({
      userId: req.auth!.userId,
      email: req.auth!.email,
      name: req.auth!.name,
      activeOrganizationId: req.auth!.activeOrganizationId ?? null,
      memberships: req.auth!.memberships,
    }),
  );

  /**
   * Create a pharmacy workspace for the signed-in user.
   *
   * Delegates to the bootstrap_organization SECURITY DEFINER function, which
   * creates the organization, its first location, an owner membership, and the
   * default alert ladder in one transaction. RLS blocks the app role from
   * inserting an organization directly, and that restriction is deliberate.
   */
  app.post(
    '/api/workspaces',
    {
      preHandler: app.requireAuth,
      schema: {
        body: Type.Object({
          name: Type.String({ minLength: 2, maxLength: 120 }),
          locationName: Type.Optional(Type.String({ minLength: 2, maxLength: 120 })),
          timezone: Type.Optional(Type.String({ maxLength: 64 })),
          currency: Type.Optional(Type.String({ minLength: 3, maxLength: 3 })),
          countryCode: Type.Optional(Type.String({ minLength: 2, maxLength: 2 })),
        }),
        response: {
          201: Type.Object({
            organizationId: Type.String(),
            slug: Type.String(),
            alertRules: Type.Integer(),
          }),
        },
      },
    },
    async (req, reply) => {
      const { userId } = req.auth!;
      const body = req.body;

      /*
       * Slug collisions are likely — "City Pharmacy" is not a rare name — so
       * retry rather than making the user invent a URL at signup.
       *
       * The first few attempts use a readable counter, then fall back to a
       * random suffix. A purely sequential scheme runs out: with -2..-5 the
       * sixth pharmacy of the same name simply cannot register, which is a
       * dead end the user can do nothing about.
       */
      const base = slugify(body.name);
      let organizationId: string | undefined;

      for (let attempt = 0; attempt < 8 && !organizationId; attempt++) {
        const slug =
          attempt === 0
            ? base
            : attempt < 4
              ? `${base}-${attempt + 1}`
              : `${base}-${randomBytes(3).toString('hex')}`;
        try {
          organizationId = await withUser(userId, async (tx) => {
            const rows = await tx.execute<{ bootstrap_organization: string }>(raw`
              SELECT bootstrap_organization(
                ${userId}::uuid, ${body.name}, ${slug},
                ${body.locationName ?? null}, ${body.timezone ?? 'Africa/Lagos'},
                ${body.currency ?? 'NGN'}, ${body.countryCode ?? 'NG'}
              )`);
            return rows[0]?.bootstrap_organization;
          });
        } catch (err) {
          const code = (err as { cause?: { code?: string }; code?: string }).cause?.code
            ?? (err as { code?: string }).code;
          if (code !== '23505') throw err;
        }
      }

      if (!organizationId) {
        throw new AppError(409, 'conflict', 'Could not allocate a workspace URL — try another name.');
      }

      const ruleRows = await withTenant({ organizationId, userId }, async (tx) =>
        tx.execute<{ n: number }>(raw`SELECT count(*)::int AS n FROM alert_rule`),
      );
      const alertRules = ruleRows[0]?.n ?? 0;

      const memberships = await loadMemberships(userId);
      const created = memberships.find((m) => m.organizationId === organizationId);

      return reply.code(201).send({
        organizationId,
        slug: created?.organizationSlug ?? base,
        alertRules,
      });
    },
  );
};
