import { describe, expect, test } from 'bun:test';
import {
  canGrantRole,
  canRevokeRole,
  canSetOverride,
  canSetStatus,
  rankIn,
  transferTargets,
  type Actor,
  type Binding,
} from '../authority';

const g = (slug: string, rank: number): Binding => ({ slug, rank, scopeType: 'global', scopeId: null });
const st = (slug: string, rank: number, storeId: string): Binding => ({
  slug,
  rank,
  scopeType: 'store',
  scopeId: storeId,
});

/** Aziz: manager (50) of store A only. */
const manager: Actor = {
  userId: 'aziz',
  isOrgAdmin: false,
  adminStoreIds: ['A'],
  bindings: [st('manager', 50, 'A')],
};
/** Nurzat: org admin (80). */
const admin: Actor = {
  userId: 'nurzat',
  isOrgAdmin: true,
  adminStoreIds: ['A', 'B'],
  bindings: [g('admin', 80)],
};
const staffA = { userId: 'dilnoza', bindings: [st('staff', 10, 'A')], storeIds: ['A'] };
const staffAB = {
  userId: 'kamola',
  bindings: [st('staff', 10, 'A'), st('staff', 10, 'B')],
  storeIds: ['A', 'B'],
};

describe('rankIn', () => {
  test('a store counts global bindings and its own, organisation-wide counts all', () => {
    const b = [g('purchaser', 30), st('manager', 50, 'A')];
    expect(rankIn(b, 'A')).toBe(50);
    expect(rankIn(b, 'B')).toBe(30);
    expect(rankIn(b, null)).toBe(50);
  });
  test('a counted binding without a rank (older server) is unknown', () => {
    expect(rankIn([{ slug: 'x', scopeType: 'global', scopeId: null }], 'A')).toBe(Infinity);
  });
});

describe('canRevokeRole (CMP-ADM-1)', () => {
  test('a manager cannot take away their own manager role (was: confirm, then 403)', () => {
    expect(canRevokeRole(manager, 'aziz', st('manager', 50, 'A'))).toBe(false);
  });
  test('a manager can take away staff in their store, not in another', () => {
    expect(canRevokeRole(manager, 'dilnoza', st('staff', 10, 'A'))).toBe(true);
    expect(canRevokeRole(manager, 'kamola', st('staff', 10, 'B'))).toBe(false);
  });
  test('an admin never removes their own admin role', () => {
    expect(canRevokeRole(admin, 'nurzat', g('admin', 80))).toBe(false);
  });
  test('without a rank the × stays and the server decides', () => {
    expect(canRevokeRole(manager, 'dilnoza', { slug: 'staff', scopeType: 'store', scopeId: 'A' })).toBe(
      true,
    );
  });
});

describe('canSetStatus', () => {
  test('nobody suspends themself', () => {
    expect(canSetStatus(admin, { userId: 'nurzat', bindings: [g('admin', 80)], storeIds: [] }, 'suspended')).toBe(
      false,
    );
  });
  test('a manager suspends staff of their only store, not someone also in another', () => {
    expect(canSetStatus(manager, staffA, 'suspended')).toBe(true);
    expect(canSetStatus(manager, staffAB, 'suspended')).toBe(false);
  });
  test('a manager cannot suspend another manager of their store', () => {
    expect(
      canSetStatus(manager, { userId: 'm2', bindings: [st('manager', 50, 'A')], storeIds: ['A'] }, 'suspended'),
    ).toBe(false);
  });
  test('an org admin needs to outrank organisation-wide', () => {
    expect(canSetStatus(admin, staffAB, 'suspended')).toBe(true);
    expect(canSetStatus(admin, { userId: 'a2', bindings: [g('admin', 80)], storeIds: [] }, 'suspended')).toBe(
      false,
    );
  });
});

describe('canGrantRole', () => {
  test('store roles only in the actor’s stores and below their rank there', () => {
    expect(canGrantRole(manager, { rank: 10 }, { type: 'store', storeId: 'A' })).toBe(true);
    expect(canGrantRole(manager, { rank: 50 }, { type: 'store', storeId: 'A' })).toBe(false);
    expect(canGrantRole(manager, { rank: 10 }, { type: 'store', storeId: 'B' })).toBe(false);
  });
  test('organisation-tier roles only globally, by an org admin who outranks them', () => {
    expect(canGrantRole(admin, { rank: 80 }, { type: 'global' })).toBe(false);
    expect(canGrantRole({ ...admin, bindings: [g('super_admin', 100)] }, { rank: 80 }, { type: 'global' })).toBe(
      true,
    );
    expect(canGrantRole(admin, { rank: 10 }, { type: 'global' })).toBe(false);
    expect(canGrantRole(manager, { rank: 80 }, { type: 'global' })).toBe(false);
  });
});

describe('transferTargets', () => {
  const stores = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
  test('managed stores the member is not in yet', () => {
    const wide = { ...admin, adminStoreIds: ['A', 'B', 'C'] };
    expect(transferTargets(wide, staffA, 'A', stores).map((s) => s.id)).toEqual(['B', 'C']);
    expect(transferTargets(wide, staffAB, 'A', stores).map((s) => s.id)).toEqual(['C']);
  });
  test('nothing when the actor does not outrank the member in the source store', () => {
    const peer = { userId: 'm2', bindings: [st('manager', 50, 'A')], storeIds: ['A'] };
    expect(transferTargets({ ...manager, adminStoreIds: ['A', 'B'] }, peer, 'A', stores)).toEqual([]);
  });
});

describe('canSetOverride', () => {
  test('organisation-wide needs an org admin; a store needs its manager; both outrank', () => {
    expect(canSetOverride(manager, staffA, null)).toBe(false);
    expect(canSetOverride(manager, staffA, 'A')).toBe(true);
    expect(canSetOverride(manager, staffAB, 'B')).toBe(false);
    expect(canSetOverride(admin, staffA, null)).toBe(true);
  });
});
