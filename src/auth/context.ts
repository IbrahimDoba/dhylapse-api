import { and, eq, isNull } from 'drizzle-orm';
import { membership, organization } from '../db/schema/index.ts';
import { withUser } from '../db/tenant.ts';

export interface Membership {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: 'owner' | 'admin' | 'pharmacist' | 'staff' | 'viewer';
  permissions: string[];
  allLocations: boolean;
}

export interface AuthContext {
  userId: string;
  email: string;
  name: string;
  memberships: Membership[];
  /** The organization this request is acting for. Undefined until one is chosen. */
  activeOrganizationId?: string | undefined;
}

/**
 * Lists the organizations a user can act for.
 *
 * Runs under `withUser`, so RLS itself decides what is visible — the query has
 * no tenant filter of its own and cannot be made to return someone else's
 * memberships by getting the WHERE clause wrong.
 */
export async function loadMemberships(userId: string): Promise<Membership[]> {
  return withUser(userId, async (tx) => {
    const rows = await tx
      .select({
        organizationId: membership.organizationId,
        organizationName: organization.name,
        organizationSlug: organization.slug,
        role: membership.role,
        permissions: membership.permissions,
        allLocations: membership.allLocations,
      })
      .from(membership)
      .innerJoin(organization, eq(organization.id, membership.organizationId))
      .where(
        and(
          eq(membership.userId, userId),
          eq(membership.status, 'active'),
          isNull(membership.deletedAt),
          isNull(organization.deletedAt),
        ),
      );

    return rows.map((r) => ({
      ...r,
      permissions: Array.isArray(r.permissions) ? (r.permissions as string[]) : [],
    }));
  });
}

/**
 * Resolves which organization a request is acting for.
 *
 * An explicit `X-Organization-Id` header wins, but only if the user is actually
 * a member — otherwise a client could act for any tenant by guessing an id.
 * With a single membership (the common case) it is chosen implicitly.
 */
export function resolveActiveOrg(
  memberships: Membership[],
  requested?: string | undefined,
): string | undefined {
  if (requested) {
    return memberships.find((m) => m.organizationId === requested)?.organizationId;
  }
  return memberships.length === 1 ? memberships[0]?.organizationId : undefined;
}
