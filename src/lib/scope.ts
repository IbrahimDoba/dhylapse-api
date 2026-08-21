import type { FastifyRequest } from 'fastify';
import type { TenantScope } from '../db/tenant.ts';
import { AppError } from './errors.ts';
import { assertCan, type Capability, type Role } from './permissions.ts';

export interface RequestScope extends TenantScope {
  organizationId: string;
  userId: string;
  role: Role;
  permissions: string[];
}

/**
 * Pulls the tenant scope off a request that has already passed `requireOrg`.
 * Throws rather than returning null so a route can never silently operate
 * without a tenant.
 */
export function scopeOf(req: FastifyRequest): RequestScope {
  const auth = req.auth;
  if (!auth) throw new AppError(401, 'unauthenticated', 'Sign in to continue.');

  const organizationId = auth.activeOrganizationId;
  if (!organizationId) {
    throw new AppError(403, 'no_organization', 'Choose a workspace first.');
  }

  const membership = auth.memberships.find((m) => m.organizationId === organizationId);
  if (!membership) throw new AppError(403, 'forbidden', 'You are not a member of that workspace.');

  return {
    organizationId,
    userId: auth.userId,
    role: membership.role,
    permissions: membership.permissions,
  };
}

export function scopeWith(req: FastifyRequest, capability: Capability): RequestScope {
  const scope = scopeOf(req);
  assertCan(scope.role, capability, scope.permissions);
  return scope;
}
