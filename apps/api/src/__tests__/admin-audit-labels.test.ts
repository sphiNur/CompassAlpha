/**
 * 2026-10-21 FE-08 (F6-02): adminAuditList resolves readable names per
 * row. These cover the pure halves (which ids a row refers to, and how
 * lookups become labels); the SQL lookups run only against a real
 * Postgres and are covered by the PG-gated adminAuditList suites.
 */
import { describe, expect, test } from 'bun:test';
import { auditRowRefs, buildAuditLabels, type AuditLookups } from '../trpc/routers/admin';

const M = '00000000-0000-4000-8000-0000000000a1';
const U = '00000000-0000-4000-8000-0000000000b1';
const S1 = '00000000-0000-4000-8000-0000000000c1';
const S2 = '00000000-0000-4000-8000-0000000000c2';
const R = '00000000-0000-4000-8000-0000000000d1';
const K = '00000000-0000-4000-8000-0000000000e1';

function lookups(over: Partial<AuditLookups> = {}): AuditLookups {
  return {
    memberNameById: new Map(),
    userNameById: new Map(),
    roleNameBySlug: new Map(),
    roleNameById: new Map(),
    storeNameById: new Map(),
    catalogNameById: new Map(),
    catalogNamesById: new Map(),
    ...over,
  };
}

describe('auditRowRefs', () => {
  test('role.grant: member target, role slug, store scope', () => {
    const refs = auditRowRefs({
      resourceType: 'member',
      resourceId: M,
      inputs: { userId: U, roleSlug: 'manager', scopeType: 'store', scopeId: S1 },
      scopeStoreId: S1,
    });
    expect(refs).toMatchObject({ memberId: M, userId: U, roleSlug: 'manager', storeId: S1 });
    expect(refs.catalog).toBeNull();
  });

  test('role.revoke: binding resource still yields the user and role', () => {
    const refs = auditRowRefs({
      resourceType: 'role_binding',
      resourceId: R,
      inputs: { bindingId: R, userId: U, roleSlug: 'staff', scopeType: 'global', scopeId: null },
      scopeStoreId: null,
    });
    expect(refs).toMatchObject({ memberId: null, userId: U, roleSlug: 'staff', storeId: null });
  });

  test('memberTransferStore: from and to stores', () => {
    const refs = auditRowRefs({
      resourceType: 'member',
      resourceId: M,
      inputs: { memberId: M, fromStoreId: S1, toStoreId: S2 },
      scopeStoreId: null,
    });
    expect(refs.storeId).toBe(S1);
    expect(refs.toStoreId).toBe(S2);
  });

  test('invite with one store resolves it; several stores do not', () => {
    const one = auditRowRefs({
      resourceType: 'member_invite',
      resourceId: R,
      inputs: { storeIds: [S1], roleSlug: 'staff' },
      scopeStoreId: S1,
    });
    expect(one.storeId).toBe(S1);
    const many = auditRowRefs({
      resourceType: 'member_invite',
      resourceId: R,
      inputs: { storeIds: [S1, S2] },
      scopeStoreId: null,
    });
    expect(many.storeId).toBeNull();
  });

  test('catalog and store resources', () => {
    expect(
      auditRowRefs({ resourceType: 'sku', resourceId: K, inputs: {}, scopeStoreId: null }).catalog,
    ).toEqual({ kind: 'sku', id: K });
    const store = auditRowRefs({
      resourceType: 'store',
      resourceId: S2,
      inputs: { storeId: S2 },
      scopeStoreId: S2,
    });
    expect(store.storeId).toBe(S2);
    expect(store.toStoreId).toBeNull();
  });

  test('tolerates null / non-object inputs and a null resourceType', () => {
    const refs = auditRowRefs({
      resourceType: null,
      resourceId: null,
      inputs: null,
      scopeStoreId: null,
    });
    expect(refs).toEqual({
      memberId: null,
      userId: null,
      roleSlug: null,
      roleId: null,
      storeId: null,
      toStoreId: null,
      catalog: null,
    });
  });
});

describe('buildAuditLabels', () => {
  test('names the member, role and store of a grant', () => {
    const refs = auditRowRefs({
      resourceType: 'member',
      resourceId: M,
      inputs: { userId: U, roleSlug: 'manager', scopeType: 'store', scopeId: S1 },
      scopeStoreId: S1,
    });
    const labels = buildAuditLabels(
      refs,
      lookups({
        memberNameById: new Map([[M, 'Ali']]),
        roleNameBySlug: new Map([['manager', 'Manager']]),
        storeNameById: new Map([[S1, 'Chilonzor']]),
      }),
    );
    expect(labels).toMatchObject({
      memberName: 'Ali',
      roleName: 'Manager',
      storeName: 'Chilonzor',
    });
  });

  test('a removed member falls back to the user name; unknown targets are null', () => {
    const refs = auditRowRefs({
      resourceType: 'member',
      resourceId: M,
      inputs: { memberId: M, userId: U },
      scopeStoreId: null,
    });
    const labels = buildAuditLabels(refs, lookups({ userNameById: new Map([[U, 'Ali']]) }));
    expect(labels.memberName).toBe('Ali');
    expect(labels.roleName).toBeNull();
    expect(buildAuditLabels(refs, lookups()).memberName).toBeNull();
  });

  test('catalog names map is passed through', () => {
    const refs = auditRowRefs({
      resourceType: 'sku',
      resourceId: K,
      inputs: {},
      scopeStoreId: null,
    });
    const labels = buildAuditLabels(
      refs,
      lookups({ catalogNamesById: new Map([[K, { en: 'Onion', zh: '洋葱' }]]) }),
    );
    expect(labels.targetNames).toEqual({ en: 'Onion', zh: '洋葱' });
    expect(labels.targetName).toBeNull();
  });
});
