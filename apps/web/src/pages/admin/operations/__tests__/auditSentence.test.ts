/**
 * 2026-10-21 FE-08 (F6-02): admin audit rows render as readable
 * sentences, including the two-segment action keys that used to show
 * the verb as "?".
 */
import { describe, expect, test } from 'bun:test';
import {
  auditCategory,
  describeAuditRow,
  parseAuditAction,
  type AuditRowLike,
} from '../auditSentence';

const loc = {
  unknown: '?',
  localName: (names: Record<string, string>) => names.en ?? Object.values(names)[0] ?? '',
};

const labels = (over: Partial<NonNullable<AuditRowLike['labels']>> = {}) => ({
  memberName: null,
  roleName: null,
  storeName: null,
  toStoreName: null,
  targetName: null,
  targetNames: null,
  ...over,
});

const actor = { displayName: 'Aziz' };

describe('parseAuditAction', () => {
  test('three-segment keys', () => {
    expect(parseAuditAction('admin.sku.update')).toEqual({ object: 'sku', verb: 'update' });
    expect(parseAuditAction('platform.subscription.update')).toEqual({
      object: 'subscription',
      verb: 'update',
    });
  });

  test('known two-segment keys no longer lose their verb', () => {
    expect(parseAuditAction('admin.memberAssignStore')).toEqual({
      object: 'member',
      verb: 'assignStore',
    });
    expect(parseAuditAction('admin.memberInviteRevoke')).toEqual({
      object: 'memberInvite',
      verb: 'revoke',
    });
    expect(parseAuditAction('admin.orgFinanceUpdate')).toEqual({
      object: 'orgFinance',
      verb: 'update',
    });
  });

  test('unknown two-segment camelCase splits on the last word', () => {
    expect(parseAuditAction('admin.fooBarArchive')).toEqual({ object: 'fooBar', verb: 'archive' });
    expect(parseAuditAction('admin.thing')).toEqual({ object: 'thing', verb: '' });
    expect(parseAuditAction('weird')).toEqual({ object: 'weird', verb: '' });
  });
});

describe('auditCategory', () => {
  test.each([
    ['admin.role.grant', 'roles'],
    ['admin.memberPermission.deny', 'roles'],
    ['admin.store.cloneRoles', 'roles'],
    ['admin.member.setStatus', 'people'],
    ['admin.memberInviteCreate', 'people'],
    ['admin.memberInviteByTgId', 'people'],
    ['admin.memberAssignStore', 'stores'],
    ['admin.memberTransferStore', 'stores'],
    ['admin.store.update', 'stores'],
    ['admin.sku.create', 'catalog'],
    ['admin.expenseTemplate.delete', 'catalog'],
    ['admin.orgFinanceUpdate', 'other'],
    ['platform.subscription.update', 'other'],
  ] as const)('%s → %s', (action, cat) => {
    expect(auditCategory(action)).toBe(cat);
  });
});

describe('describeAuditRow', () => {
  test('role grant names actor, member and role', () => {
    const s = describeAuditRow(
      {
        action: 'admin.role.grant',
        inputs: { roleSlug: 'manager' },
        actor,
        labels: labels({ memberName: 'Ali', roleName: 'Manager', storeName: 'Chilonzor' }),
      },
      loc,
    );
    expect(s).toMatchObject({
      key: 'ops.audit.s.roleGrant',
      category: 'roles',
      tone: 'success',
      params: { actor: 'Aziz', member: 'Ali', role: 'Manager' },
    });
  });

  test('role revoke of a removed member falls back to placeholders / slug', () => {
    const s = describeAuditRow(
      { action: 'admin.role.revoke', inputs: { roleSlug: 'staff' }, actor: null, labels: labels() },
      loc,
    );
    expect(s.key).toBe('ops.audit.s.roleRevoke');
    expect(s.tone).toBe('danger');
    expect(s.params).toEqual({ actor: '?', member: '?', role: 'staff' });
  });

  test('two-segment store transfer', () => {
    const s = describeAuditRow(
      {
        action: 'admin.memberTransferStore',
        inputs: {},
        actor,
        labels: labels({ memberName: 'Ali', storeName: 'A', toStoreName: 'B' }),
      },
      loc,
    );
    expect(s.key).toBe('ops.audit.s.storeTransfer');
    expect(s.params).toMatchObject({ member: 'Ali', from: 'A', to: 'B' });
  });

  test('member status: suspend vs reactivate', () => {
    const row = (status: string): AuditRowLike => ({
      action: 'admin.member.setStatus',
      inputs: { status },
      actor,
      labels: labels({ memberName: 'Ali' }),
    });
    expect(describeAuditRow(row('suspended'), loc)).toMatchObject({
      key: 'ops.audit.s.memberSuspend',
      tone: 'danger',
    });
    expect(describeAuditRow(row('active'), loc).key).toBe('ops.audit.s.memberReactivate');
  });

  test('catalog: localized names, archive via update, restore', () => {
    const base = { actor, labels: labels({ targetNames: { en: 'Onion', zh: '洋葱' } }) };
    expect(
      describeAuditRow({ ...base, action: 'admin.sku.create', inputs: {} }, loc),
    ).toMatchObject({ key: 'ops.audit.s.catalogCreate', object: 'sku', params: { name: 'Onion' } });
    expect(
      describeAuditRow({ ...base, action: 'admin.sku.update', inputs: { isArchived: true } }, loc)
        .key,
    ).toBe('ops.audit.s.catalogArchive');
    expect(
      describeAuditRow({ ...base, action: 'admin.sku.update', inputs: { isArchived: false } }, loc)
        .key,
    ).toBe('ops.audit.s.catalogRestore');
    expect(
      describeAuditRow(
        {
          action: 'admin.supplier.delete',
          inputs: {},
          actor,
          labels: labels({ targetName: 'Bazaar' }),
        },
        loc,
      ),
    ).toMatchObject({ key: 'ops.audit.s.catalogArchive', params: { name: 'Bazaar' } });
  });

  test('rows from an older server (no labels) still render', () => {
    const s = describeAuditRow({ action: 'admin.store.update', inputs: {}, actor }, loc);
    expect(s).toMatchObject({ key: 'ops.audit.s.storeUpdate', params: { store: '?' } });
  });

  test('unknown action → generic sentence with parsed words', () => {
    const s = describeAuditRow(
      { action: 'admin.fooBarArchive', inputs: null, actor, labels: null },
      loc,
    );
    expect(s).toMatchObject({
      key: 'ops.audit.s.generic',
      category: 'other',
      params: { actor: 'Aziz', object: 'fooBar', verb: 'archive' },
    });
  });
});
