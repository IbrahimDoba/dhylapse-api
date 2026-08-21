import { AppError } from './errors.ts';

/**
 * Capability check.
 *
 * Roles are coarse presets; `membership.permissions` carries additive grants so
 * "Tomi can approve disposals but not invite staff" is a data change rather
 * than a release. Checks are always against a capability, never a role name —
 * that way adding a role later doesn't mean auditing every route.
 */
export type Role = 'owner' | 'admin' | 'pharmacist' | 'staff' | 'viewer';

export type Capability =
  | 'inventory.read'
  | 'inventory.write'
  | 'inventory.adjust'
  | 'catalog.write'
  | 'alerts.acknowledge'
  | 'disposal.approve'
  | 'staff.manage'
  | 'org.manage';

const ROLE_CAPABILITIES: Record<Role, Capability[]> = {
  owner: [
    'inventory.read', 'inventory.write', 'inventory.adjust', 'catalog.write',
    'alerts.acknowledge', 'disposal.approve', 'staff.manage', 'org.manage',
  ],
  admin: [
    'inventory.read', 'inventory.write', 'inventory.adjust', 'catalog.write',
    'alerts.acknowledge', 'disposal.approve', 'staff.manage',
  ],
  pharmacist: [
    'inventory.read', 'inventory.write', 'inventory.adjust', 'catalog.write',
    'alerts.acknowledge', 'disposal.approve',
  ],
  // Counter staff receive stock and acknowledge alerts, but do not correct
  // balances or approve write-offs — those are the abuse-prone actions.
  staff: ['inventory.read', 'inventory.write', 'alerts.acknowledge'],
  viewer: ['inventory.read'],
};

export function can(role: Role, capability: Capability, granted: string[] = []): boolean {
  return ROLE_CAPABILITIES[role]?.includes(capability) || granted.includes(capability);
}

export function assertCan(role: Role, capability: Capability, granted: string[] = []): void {
  if (!can(role, capability, granted)) {
    throw new AppError(403, 'forbidden', `Your role (${role}) cannot ${capability.replace('.', ' ')}.`);
  }
}
