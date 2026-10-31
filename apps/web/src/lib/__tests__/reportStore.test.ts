import { describe, expect, test } from 'bun:test';
import { defaultReportStore } from '../reportStore';

// CMP-HIS-1 (2026-10-31): History and Finance follow the top bar's store.
describe('defaultReportStore', () => {
  const stores = [{ id: 'central' }, { id: 'eden' }];

  test('the store picked in the top bar', () => {
    expect(defaultReportStore({ kind: 'specific', storeId: 'eden' }, stores)).toBe('eden');
  });

  test('all stores only when "all stores" is picked or there is no store', () => {
    expect(defaultReportStore({ kind: 'all' }, stores)).toBe('');
    expect(defaultReportStore({ kind: 'none' }, stores)).toBe('');
  });

  test('a store the reader may not see the report for falls back to all', () => {
    // The server refuses a storeId outside the reader's report stores.
    expect(defaultReportStore({ kind: 'specific', storeId: 'other' }, stores)).toBe('');
    expect(defaultReportStore({ kind: 'specific', storeId: 'eden' }, undefined)).toBe('');
  });
});
