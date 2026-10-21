import { describe, expect, test } from 'bun:test';
import { isTabVisible, resolveVisibleTab } from '../navStore';

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
