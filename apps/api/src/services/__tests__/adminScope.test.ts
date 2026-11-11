/**
 * Review ADM1-03 / COREAPI-08 (2026-11-10): one rule for "which stores may
 * this member manage people in". The session payload, the admin router and
 * invite acceptance each had their own copy; two walked the overrides in
 * database order. These tables pin the shared rule.
 */
import { describe, expect, test } from 'bun:test';
import { adminScopeOf, adminStoresOf } from '../storeScope';
import { inviterCoversInvite, type InviterAuthority } from '../adminAuthority';

type Row = { key: string; scopeType: string; scopeId: string | null };
type Override = Row & { effect: string };

const store = (key: string, id: string): Row => ({ key, scopeType: 'store', scopeId: id });
const global = (key: string): Row => ({ key, scopeType: 'global', scopeId: null });
const allow = (row: Row): Override => ({ ...row, effect: 'allow' });
const deny = (row: Row): Override => ({ ...row, effect: 'deny' });

const sorted = (ids: Iterable<string>) => [...ids].sort();

describe('adminScopeOf', () => {
  const cases: Array<{
    name: string;
    grants: Row[];
    overrides: Override[];
    global: boolean;
    stores: string[];
    denied: string[];
  }> = [
    {
      name: 'a store manager administers their store',
      grants: [store('users.manage', 'A')],
      overrides: [],
      global: false,
      stores: ['A'],
      denied: [],
    },
    {
      name: 'a global grant makes a global admin',
      grants: [global('users.grant_role')],
      overrides: [],
      global: true,
      stores: [],
      denied: [],
    },
    {
      name: 'a store allow of one key survives a deny of another (ADM1-03 point 2)',
      grants: [],
      overrides: [allow(store('users.grant_role', 'A')), deny(store('users.manage', 'A'))],
      global: false,
      stores: ['A'],
      denied: [],
    },
    {
      name: 'the same rows in the other order give the same answer (ADM1-03 point 1)',
      grants: [],
      overrides: [deny(store('users.manage', 'A')), allow(store('users.grant_role', 'A'))],
      global: false,
      stores: ['A'],
      denied: [],
    },
    {
      name: 'an allow and a deny of the same key: deny wins, in either order',
      grants: [],
      overrides: [deny(store('users.manage', 'A')), allow(store('users.manage', 'A'))],
      global: false,
      stores: [],
      denied: ['A'],
    },
    {
      name: 'denying one admin key keeps the store while another is held',
      grants: [store('users.manage', 'A'), store('users.grant_role', 'A')],
      overrides: [deny(store('users.manage', 'A'))],
      global: false,
      stores: ['A'],
      denied: [],
    },
    {
      name: 'denying every admin key in a store takes it away',
      grants: [store('users.manage', 'A'), store('users.manage', 'B')],
      overrides: [deny(store('users.manage', 'A'))],
      global: false,
      stores: ['B'],
      denied: ['A'],
    },
    {
      name: 'a store deny limits a global admin there (ADM1-03 point 3)',
      grants: [global('users.manage')],
      overrides: [deny(store('users.manage', 'A'))],
      global: true,
      stores: [],
      denied: ['A'],
    },
    {
      name: 'a global deny ends global authority, a store grant still counts',
      grants: [global('users.manage'), store('users.grant_role', 'B')],
      overrides: [deny(global('users.manage'))],
      global: false,
      stores: ['B'],
      denied: [],
    },
    {
      name: 'keys that give no authority over people are ignored',
      grants: [store('order.approve', 'A'), global('prices.view')],
      overrides: [],
      global: false,
      stores: [],
      denied: ['A'],
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const scope = adminScopeOf(c.grants, c.overrides);
      expect(scope.isGlobalAdmin).toBe(c.global);
      expect(sorted(scope.storeIds)).toEqual(c.stores);
      expect(sorted(scope.deniedStoreIds)).toEqual(c.denied);
    });
  }

  test('hasUsersManage follows the per-scope rule too', () => {
    expect(adminScopeOf([store('users.manage', 'A')], []).hasUsersManage).toBe(true);
    expect(
      adminScopeOf([store('users.manage', 'A')], [deny(store('users.manage', 'A'))]).hasUsersManage,
    ).toBe(false);
    expect(
      adminScopeOf(
        [store('users.manage', 'A'), store('users.manage', 'B')],
        [deny(store('users.manage', 'A'))],
      ).hasUsersManage,
    ).toBe(true);
    expect(adminScopeOf([global('users.grant_role')], []).hasUsersManage).toBe(false);
  });
});

describe('adminStoresOf', () => {
  test('a global admin gets every candidate but the denied ones', () => {
    const scope = adminScopeOf([global('users.manage')], [deny(store('users.manage', 'B'))]);
    expect(adminStoresOf(scope, ['A', 'B', 'C'])).toEqual(['A', 'C']);
  });

  test('a store admin gets only the candidates they administer', () => {
    const scope = adminScopeOf([store('users.manage', 'A'), store('users.manage', 'C')], []);
    // B is not theirs; C is not a candidate (an archived store left out).
    expect(adminStoresOf(scope, ['A', 'B'])).toEqual(['A']);
  });

  test('no authority, no stores', () => {
    expect(adminStoresOf(adminScopeOf([], []), ['A'])).toEqual([]);
  });
});

describe('inviterCoversInvite', () => {
  const authority = (over: Partial<InviterAuthority>): InviterAuthority => ({
    active: true,
    hasUsersManage: true,
    isGlobalAdmin: false,
    adminStoreIds: new Set(),
    ...over,
  });

  test('a global inviter covers every store but the denied ones', () => {
    const inviter = authority({ isGlobalAdmin: true, deniedStoreIds: new Set(['B']) });
    expect(inviterCoversInvite(inviter, ['A'])).toBe(true);
    expect(inviterCoversInvite(inviter, ['A', 'B'])).toBe(false);
    expect(inviterCoversInvite(inviter, [])).toBe(true);
  });

  test('a store inviter covers only their stores, and never an org-level invite', () => {
    const inviter = authority({ adminStoreIds: new Set(['A']) });
    expect(inviterCoversInvite(inviter, ['A'])).toBe(true);
    expect(inviterCoversInvite(inviter, ['A', 'B'])).toBe(false);
    expect(inviterCoversInvite(inviter, [])).toBe(false);
  });

  test('a suspended inviter or one without users.manage covers nothing', () => {
    expect(inviterCoversInvite(authority({ active: false, isGlobalAdmin: true }), ['A'])).toBe(
      false,
    );
    expect(
      inviterCoversInvite(authority({ hasUsersManage: false, isGlobalAdmin: true }), ['A']),
    ).toBe(false);
  });
});
