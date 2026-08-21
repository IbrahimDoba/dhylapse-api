import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertCan, can, type Role } from './permissions.ts';
import { AppError } from './errors.ts';

const ALL_ROLES: Role[] = ['owner', 'admin', 'pharmacist', 'staff', 'viewer'];

describe('capabilities', () => {
  it('lets every role read inventory', () => {
    for (const role of ALL_ROLES) {
      assert.ok(can(role, 'inventory.read'), `${role} should read`);
    }
  });

  it('does not let a viewer write', () => {
    assert.equal(can('viewer', 'inventory.write'), false);
    assert.equal(can('viewer', 'catalog.write'), false);
  });

  it('lets counter staff receive stock but not correct balances', () => {
    // Receiving is routine; adjusting a balance is the abuse-prone action.
    assert.equal(can('staff', 'inventory.write'), true);
    assert.equal(can('staff', 'inventory.adjust'), false);
    assert.equal(can('staff', 'disposal.approve'), false);
  });

  it('reserves org management for the owner', () => {
    assert.equal(can('owner', 'org.manage'), true);
    for (const role of ['admin', 'pharmacist', 'staff', 'viewer'] as Role[]) {
      assert.equal(can(role, 'org.manage'), false, `${role} must not manage the org`);
    }
  });

  it('honours additive per-member grants', () => {
    // "Tomi can approve disposals but is not a pharmacist" is a data change.
    assert.equal(can('staff', 'disposal.approve'), false);
    assert.equal(can('staff', 'disposal.approve', ['disposal.approve']), true);
  });

  it('ignores irrelevant grants', () => {
    assert.equal(can('viewer', 'org.manage', ['inventory.read']), false);
  });

  it('assertCan throws a 403 naming the role', () => {
    assert.throws(
      () => assertCan('viewer', 'inventory.write'),
      (e: unknown) => e instanceof AppError && e.statusCode === 403 && /viewer/.test(e.message),
    );
  });

  it('assertCan is silent when permitted', () => {
    assert.doesNotThrow(() => assertCan('owner', 'org.manage'));
  });
});
