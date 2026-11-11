/**
 * Review ADM1-05 (2026-11-10): the member permissions screen reads each
 * scope's own keys. It showed one union of every binding on every tab.
 */
import { describe, expect, test } from 'bun:test';
import { permissionsByScope } from '../storeScope';

const store = (key: string, id: string) => ({ key, scopeType: 'store', scopeId: id });
const global = (key: string) => ({ key, scopeType: 'global', scopeId: null });

describe('permissionsByScope', () => {
  test('a manager of A who is staff in B: approve comes from a role in A only', () => {
    const scopes = permissionsByScope(
      [store('order.approve', 'A'), store('order.draft', 'A'), store('order.draft', 'B')],
      [],
    );
    expect(scopes.global.roleKeys).toEqual([]);
    expect(scopes.stores.A?.roleKeys).toEqual(['order.approve', 'order.draft']);
    expect(scopes.stores.B?.roleKeys).toEqual(['order.draft']);
  });

  test('a store deny takes the key away in that store only', () => {
    const scopes = permissionsByScope(
      [global('reports.view'), store('order.approve', 'A'), store('order.approve', 'B')],
      [{ ...store('order.approve', 'A'), effect: 'deny' }],
    );
    expect(scopes.stores.A?.effective).toEqual(['reports.view']);
    expect(scopes.stores.B?.effective).toEqual(['order.approve', 'reports.view']);
    // The role still gives it in A; the override is what removes it.
    expect(scopes.stores.A?.roleKeys).toEqual(['order.approve', 'reports.view']);
  });

  test('global roles count in every store; an allow adds where it is set', () => {
    const scopes = permissionsByScope(
      [global('prices.view')],
      [{ ...store('sales.record', 'C'), effect: 'allow' }],
    );
    expect(scopes.global.effective).toEqual(['prices.view']);
    expect(scopes.stores.C?.roleKeys).toEqual(['prices.view']);
    expect(scopes.stores.C?.effective).toEqual(['prices.view', 'sales.record']);
  });

  test('org-wide keys come from global rows only, in every scope', () => {
    const scopes = permissionsByScope([store('org.admin', 'A')], []);
    expect(scopes.stores.A?.roleKeys).toEqual([]);
    expect(scopes.global.roleKeys).toEqual([]);
  });
});
