import { describe, expect, test } from 'bun:test';
import {
  canDetachFromStore,
  canGrantRole,
  canRemoveFromOrg,
  canRename,
  canRevokeRole,
  canSetOverride,
  canSetStatus,
  orgRankOf,
  rankIn,
  rolePassesOn,
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

/** Alice: manager (50) of store A only. */
const manager: Actor = {
  userId: 'alice',
  isOrgAdmin: false,
  adminStoreIds: ['A'],
  bindings: [st('manager', 50, 'A')],
};
/** Olga: org admin (80). */
const admin: Actor = {
  userId: 'olga',
  isOrgAdmin: true,
  adminStoreIds: ['A', 'B'],
  bindings: [g('admin', 80)],
};
const staffA = { userId: 'dana', bindings: [st('staff', 10, 'A')], storeIds: ['A'] };
const staffAB = {
  userId: 'kate',
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

/**
 * ADM1-01 (2026-11-09): Olga is an org admin (80) who also kept a
 * legacy super_admin (100) binding in store A. Organisation-wide she
 * weighs 80, as the server now ranks her (getActorMaxGlobalRank).
 */
const legacyAdmin: Actor = { ...admin, bindings: [g('admin', 80), st('super_admin', 100, 'A')] };
const peerAdmin = { userId: 'a2', bindings: [g('admin', 80)], storeIds: [] };

describe('orgRankOf (ADM1-01)', () => {
  test('only global bindings count organisation-wide', () => {
    expect(orgRankOf(legacyAdmin.bindings)).toBe(80);
    expect(rankIn(legacyAdmin.bindings, null)).toBe(100);
    expect(orgRankOf([st('manager', 50, 'A')])).toBe(0);
  });
  test('a global binding without a rank (older server) is unknown; a store one is ignored', () => {
    expect(orgRankOf([{ slug: 'x', scopeType: 'global', scopeId: null }])).toBe(Infinity);
    expect(orgRankOf([g('admin', 80), { slug: 'x', scopeType: 'store', scopeId: 'A' }])).toBe(80);
  });
  test('a store binding gives no organisation-wide reach to the actor', () => {
    expect(canGrantRole(legacyAdmin, { rank: 80 }, { type: 'global' })).toBe(false);
    expect(canSetStatus(legacyAdmin, peerAdmin, 'suspended')).toBe(false);
    expect(canSetOverride(legacyAdmin, peerAdmin, null)).toBe(false);
    expect(canRevokeRole(legacyAdmin, 'a2', g('admin', 80))).toBe(false);
    // In store A the legacy binding still counts, as on the server.
    expect(canSetOverride(legacyAdmin, { ...peerAdmin, storeIds: ['A'] }, 'A')).toBe(true);
  });
});

describe('canRevokeRole (CMP-ADM-1)', () => {
  test('a manager cannot take away their own manager role (was: confirm, then 403)', () => {
    expect(canRevokeRole(manager, 'alice', st('manager', 50, 'A'))).toBe(false);
  });
  test('a manager can take away staff in their store, not in another', () => {
    expect(canRevokeRole(manager, 'dana', st('staff', 10, 'A'))).toBe(true);
    expect(canRevokeRole(manager, 'kate', st('staff', 10, 'B'))).toBe(false);
  });
  test('an admin never removes their own admin role', () => {
    expect(canRevokeRole(admin, 'olga', g('admin', 80))).toBe(false);
  });
  test('a global binding needs an org admin, whatever the rank (ADM1-17)', () => {
    const legacyStaff = g('staff', 10);
    expect(canRevokeRole(manager, 'dana', legacyStaff)).toBe(false);
    expect(canRevokeRole(admin, 'dana', legacyStaff)).toBe(true);
    expect(
      canRevokeRole(manager, 'dana', { slug: 'staff', scopeType: 'global', scopeId: null }),
    ).toBe(false);
  });
  test('without a rank the × stays and the server decides', () => {
    expect(canRevokeRole(manager, 'dana', { slug: 'staff', scopeType: 'store', scopeId: 'A' })).toBe(
      true,
    );
  });
});

describe('canSetStatus', () => {
  test('nobody suspends themself', () => {
    expect(canSetStatus(admin, { userId: 'olga', bindings: [g('admin', 80)], storeIds: [] }, 'suspended')).toBe(
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

describe('rolePassesOn (DX-ADM-1)', () => {
  test('a store grant needs the keys in that store, a global one org-wide', () => {
    const role = { passOn: { global: false, storeIds: ['A'] } };
    expect(rolePassesOn(role, { type: 'store', storeId: 'A' })).toBe(true);
    expect(rolePassesOn(role, { type: 'store', storeId: 'B' })).toBe(false);
    expect(rolePassesOn(role, { type: 'global' })).toBe(false);
    expect(rolePassesOn({ passOn: { global: true, storeIds: [] } }, { type: 'global' })).toBe(true);
  });
  test('a role from an older server without passOn is left to the server', () => {
    expect(rolePassesOn({}, { type: 'store', storeId: 'A' })).toBe(true);
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

/**
 * COREWEB2-11 / ADM1-16 (2026-11-10): store P is paused. Alice still
 * manages it (session.inactiveAdminStoreIds), so they may take people out
 * of it and act on its members, never add anyone there.
 */
describe('paused and archived stores', () => {
  const pausedManager: Actor = {
    userId: 'alice',
    isOrgAdmin: false,
    adminStoreIds: ['A'],
    inactiveAdminStoreIds: ['P'],
    bindings: [st('manager', 50, 'A'), st('manager', 50, 'P')],
  };
  const staffP = { userId: 'dana', bindings: [st('staff', 10, 'P')], storeIds: ['P'] };
  const staffAP = {
    userId: 'kate',
    bindings: [st('staff', 10, 'A'), st('staff', 10, 'P')],
    storeIds: ['A', 'P'],
  };

  test('a role in a paused store can be revoked (the × was missing)', () => {
    expect(canRevokeRole(pausedManager, 'dana', st('staff', 10, 'P'))).toBe(true);
    // An older session without the list: the store stays out of reach.
    const older: Actor = { ...pausedManager, inactiveAdminStoreIds: undefined };
    expect(canRevokeRole(older, 'dana', st('staff', 10, 'P'))).toBe(false);
  });

  test('nothing is added there: no grant, no override', () => {
    expect(canGrantRole(pausedManager, { rank: 10 }, { type: 'store', storeId: 'P' })).toBe(false);
    expect(canSetOverride(pausedManager, staffP, 'P')).toBe(false);
  });

  test('its members can be suspended by whoever manages it', () => {
    expect(canSetStatus(pausedManager, staffP, 'suspended')).toBe(true);
    expect(canSetStatus(pausedManager, staffAP, 'suspended')).toBe(true);
    expect(canSetStatus(manager, staffAP, 'suspended')).toBe(false);
  });

  test('a transfer may leave it, not go into it', () => {
    const stores = [{ id: 'A' }, { id: 'B' }, { id: 'P' }];
    const wide: Actor = { ...pausedManager, adminStoreIds: ['A', 'B'] };
    expect(transferTargets(wide, staffP, 'P', stores).map((s) => s.id)).toEqual(['A', 'B']);
    expect(transferTargets(wide, staffA, 'A', stores).map((s) => s.id)).toEqual(['B']);
  });
});

/**
 * ADM1-06 / ADM1-07 (2026-11-10): renaming, removing from the workspace
 * and taking out of a store, as the server decides them.
 */
describe('canRename', () => {
  test('everyone may rename themself, even a store manager (was: refused by rank)', () => {
    const self = { userId: manager.userId, bindings: manager.bindings, storeIds: ['A'] };
    expect(canRename(manager, self)).toBe(true);
  });
  test('someone another workspace also has keeps their name', () => {
    expect(canRename(admin, { ...staffA, nameShared: true })).toBe(false);
    expect(canRename(manager, { ...staffA, nameShared: true })).toBe(false);
  });
  test('an org admin outranks the member, or is a super admin', () => {
    const peerAdmin = { userId: 'p', bindings: [g('admin', 80)], storeIds: [] };
    expect(canRename(admin, staffA)).toBe(true);
    expect(canRename(admin, peerAdmin)).toBe(false);
    const owner: Actor = { ...admin, userId: 'owner', bindings: [g('super_admin', 100)] };
    const otherOwner = { userId: 'o2', bindings: [g('super_admin', 100)], storeIds: [] };
    expect(canRename(owner, otherOwner)).toBe(true);
  });
  test('anyone else needs every store of the member, and to outrank them there', () => {
    expect(canRename(manager, staffA)).toBe(true);
    expect(canRename(manager, staffAB)).toBe(false);
    expect(canRename(manager, { ...staffA, outOfReach: true })).toBe(false);
    const peer = { userId: 'm2', bindings: [st('manager', 50, 'A')], storeIds: ['A'] };
    expect(canRename(manager, peer)).toBe(false);
  });
});

describe('canSetStatus with stores out of view', () => {
  test('a store the actor cannot see makes the member out of reach', () => {
    expect(canSetStatus(manager, { ...staffA, outOfReach: true }, 'suspended')).toBe(false);
    // An org admin sees every store; the flag does not come up for them.
    expect(canSetStatus(admin, staffA, 'suspended')).toBe(true);
  });
});

describe('canRemoveFromOrg', () => {
  test('an org admin, not on themself, who outranks the member', () => {
    expect(canRemoveFromOrg(admin, staffA)).toBe(true);
    expect(canRemoveFromOrg(manager, staffA)).toBe(false);
    expect(
      canRemoveFromOrg(admin, { userId: admin.userId, bindings: admin.bindings, storeIds: [] }),
    ).toBe(false);
    const peerAdmin = { userId: 'p', bindings: [g('admin', 80)], storeIds: [] };
    expect(canRemoveFromOrg(admin, peerAdmin)).toBe(false);
  });
  test('someone holding no role at all can go', () => {
    expect(canRemoveFromOrg(admin, { userId: 'x', bindings: [], storeIds: ['A'] })).toBe(true);
  });
});

describe('canDetachFromStore', () => {
  test('the store manager takes out those below them, in their store only', () => {
    expect(canDetachFromStore(manager, staffA, 'A')).toBe(true);
    expect(canDetachFromStore(manager, staffAB, 'B')).toBe(false);
    const peer = { userId: 'm2', bindings: [st('manager', 50, 'A')], storeIds: ['A'] };
    expect(canDetachFromStore(manager, peer, 'A')).toBe(false);
  });
  test('a paused store counts for taking people out', () => {
    const pausedManager: Actor = {
      ...manager,
      inactiveAdminStoreIds: ['P'],
      bindings: [st('manager', 50, 'A'), st('manager', 50, 'P')],
    };
    const staffP = { userId: 'd', bindings: [st('staff', 10, 'P')], storeIds: ['P'] };
    expect(canDetachFromStore(pausedManager, staffP, 'P')).toBe(true);
  });
});
