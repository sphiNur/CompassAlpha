/**
 * Review ADM1-13: the three permission lists group and order alike.
 */
import { describe, expect, test } from 'bun:test';
import { groupPermissions } from '../permissionGroups';

const PERMS = [
  { key: 'orders.approve' },
  { key: 'run.create' },
  { key: 'orders.submit' },
  { key: 'catalog.manage' },
  { key: 'run.purchase' },
];

describe('groupPermissions', () => {
  test('groups by the first segment and keeps the order within a group', () => {
    const groups = groupPermissions(PERMS, (s) => s, 'en');
    expect(groups).toEqual([
      ['catalog', [{ key: 'catalog.manage' }]],
      ['orders', [{ key: 'orders.approve' }, { key: 'orders.submit' }]],
      ['run', [{ key: 'run.create' }, { key: 'run.purchase' }]],
    ]);
  });

  test('orders the groups by the name the reader sees, not by the segment', () => {
    const names: Record<string, string> = { catalog: 'Товары', orders: 'Заказы', run: 'Закупка' };
    const groups = groupPermissions(PERMS, (s) => names[s] ?? s, 'ru');
    expect(groups.map(([segment]) => segment)).toEqual(['orders', 'run', 'catalog']);
  });

  test('keeps the rest of each item', () => {
    const groups = groupPermissions(
      [{ key: 'run.create', passOn: { global: false, storeIds: ['A'] } }],
      (s) => s,
      'en',
    );
    expect(groups).toEqual([
      ['run', [{ key: 'run.create', passOn: { global: false, storeIds: ['A'] } }]],
    ]);
  });
});
