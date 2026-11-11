import { describe, expect, test } from 'bun:test';
import {
  ADMIN_SECTIONS,
  CATALOG_SUBS,
  isTab,
  isTabVisible,
  OPERATIONS_SUBS,
  resolveVisibleTab,
  restoreNav,
  STORE_SUBS,
  TAB_KEYS,
} from '../navStore';

const SALES_TAB = { permission: 'sales.record', hiddenWith: 'settlement.record' };

describe('isTabVisible (2026-10-21 staff Sales tab)', () => {
  test('staff (sales.record only) see the Sales tab', () => {
    expect(isTabVisible(SALES_TAB, ['order.draft', 'sales.record'])).toBe(true);
  });
  test('settlement.record holders do not — they use the Settlement block', () => {
    expect(isTabVisible(SALES_TAB, ['sales.record', 'settlement.record'])).toBe(false);
  });
  test('without sales.record the tab is hidden', () => {
    expect(isTabVisible(SALES_TAB, ['order.draft'])).toBe(false);
  });
  test('tabs without a permission are always visible', () => {
    expect(isTabVisible({ permission: null }, [])).toBe(true);
  });
});

describe('resolveVisibleTab', () => {
  test('keeps a visible persisted tab', () => {
    expect(resolveVisibleTab('sales', ['order', 'sales'])).toBe('sales');
  });
  test('sales → settlement when the user gained settlement.record', () => {
    expect(resolveVisibleTab('sales', ['order', 'settlement'])).toBe('settlement');
  });
  test('settlement → sales when the user lost settlement.record', () => {
    expect(resolveVisibleTab('settlement', ['order', 'sales'])).toBe('sales');
  });
  test('otherwise falls back to the first visible tab', () => {
    expect(resolveVisibleTab('run', ['order', 'confirm'])).toBe('order');
    expect(resolveVisibleTab('sales', [])).toBe('order');
  });
});

describe('one list of tabs and admin pages (review COREWEB1-11)', () => {
  test('no list names a key twice', () => {
    for (const list of [TAB_KEYS, ADMIN_SECTIONS, CATALOG_SUBS, OPERATIONS_SUBS, STORE_SUBS]) {
      expect(new Set<string>(list).size).toBe(list.length);
    }
  });

  test('isTab takes the tabs and nothing else', () => {
    for (const tab of TAB_KEYS) expect(isTab(tab)).toBe(true);
    for (const junk of ['toString', 'constructor', 'Order', '', null, 3]) {
      expect(isTab(junk)).toBe(false);
    }
  });
});

describe('restoreNav: what a reload brings back', () => {
  test('every tab, and the order tab for anything else', () => {
    for (const tab of TAB_KEYS) expect(restoreNav({ tab }).tab).toBe(tab);
    expect(restoreNav({ tab: 'nope' }).tab).toBe('order');
    expect(restoreNav(null).tab).toBe('order');
  });

  test('every admin section and catalog page', () => {
    for (const adminSection of ADMIN_SECTIONS) {
      expect(restoreNav({ adminSection }).adminSection).toBe(adminSection);
    }
    for (const catalogSub of CATALOG_SUBS) {
      expect(restoreNav({ adminSection: 'catalog', catalogSub }).catalogSub).toBe(catalogSub);
    }
    expect(restoreNav({ adminSection: null, catalogSub: 'skus' })).toMatchObject({
      adminSection: 'home',
      catalogSub: null,
    });
  });

  test('every operations page but maintenance, which is opened on purpose', () => {
    for (const opsSub of OPERATIONS_SUBS) {
      expect(restoreNav({ adminSection: 'operations', opsSub }).opsSub).toBe(
        opsSub === 'maintenance' ? null : opsSub,
      );
    }
  });

  test('a page inside another section is dropped, and a store only in Stores', () => {
    expect(restoreNav({ adminSection: 'stores', catalogSub: 'skus' }).catalogSub).toBeNull();
    const store = { kind: 'store', storeId: 's1', storeName: 'Store A' } as const;
    expect(restoreNav({ adminSection: 'stores', storeFocus: store }).storeFocus).toEqual(store);
    expect(restoreNav({ adminSection: 'catalog', storeFocus: store }).storeFocus).toBeNull();
    for (const storeSub of STORE_SUBS) {
      expect(restoreNav({ storeSub }).storeSub).toBe(storeSub);
    }
    expect(restoreNav({ storeSub: 'payroll' }).storeSub).toBe('team');
  });
});
