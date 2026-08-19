import { sql as raw } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { db } from './client.ts';

export type TenantTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Runs `fn` inside a transaction scoped to one organization.
 *
 * Every tenant-scoped query in the application must go through this. The RLS
 * policies read `app.organization_id`, and if it is unset they match no rows —
 * so forgetting this wrapper produces an empty result, never another tenant's
 * data. It fails closed.
 *
 * Two details that are easy to get wrong:
 *
 * 1. `set_config(..., is_local => true)` rather than `SET LOCAL`. `SET LOCAL`
 *    cannot take a bind parameter, so the org id would have to be interpolated
 *    into the SQL string — an injection vector on the one value that decides
 *    which tenant's data you can see.
 *
 * 2. `is_local => true` scopes the setting to the transaction. With a plain
 *    `set_config(..., false)` the value persists on the pooled connection and
 *    leaks into whichever request picks it up next.
 */
export interface TenantScope {
  organizationId: string;
  /** Who is acting. Optional for background jobs that act as the system. */
  userId?: string | undefined;
}

export async function withTenant<T>(
  scope: TenantScope | string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  const { organizationId, userId } = typeof scope === 'string' ? { organizationId: scope, userId: undefined } : scope;
  return db.transaction(async (tx) => {
    await tx.execute(raw`SELECT set_config('app.organization_id', ${organizationId}, true)`);
    await tx.execute(raw`SELECT set_config('app.user_id', ${userId ?? ''}, true)`);
    return fn(tx);
  });
}

/**
 * Identity without a tenant. The only thing visible here is the caller's own
 * memberships and the organizations they belong to — which is exactly what an
 * org switcher needs, and nothing more.
 */
export async function withUser<T>(userId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(raw`SELECT set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}

/**
 * Escape hatch for genuinely cross-tenant work: the nightly expiry scan, the
 * signup path before an org exists, platform admin tooling.
 *
 * Named to be conspicuous in review. Anything using this is outside RLS
 * protection and must scope by organization_id itself.
 */
export async function withoutTenant<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}
