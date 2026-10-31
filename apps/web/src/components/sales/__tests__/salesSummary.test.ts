import { describe, expect, test } from 'bun:test';
import { normalizeVoidReason, salesListView, summarizeSales } from '../salesSummary';

describe('summarizeSales', () => {
  test('sums servings and priced revenue', () => {
    expect(
      summarizeSales([
        { qty: '2', unitPrice: '10.00' },
        { qty: '1.5', unitPrice: null },
      ]),
    ).toEqual({ count: 3.5, revenue: 20 });
  });

  test('voided sales are excluded from both totals', () => {
    expect(
      summarizeSales([
        { qty: '2', unitPrice: '10.00' },
        { qty: '5', unitPrice: '10.00', voidedAt: '2026-10-21T10:00:00Z' },
      ]),
    ).toEqual({ count: 2, revenue: 20 });
  });
});

describe('normalizeVoidReason', () => {
  test('trims and accepts 1..300 chars', () => {
    expect(normalizeVoidReason('  wrong dish ')).toBe('wrong dish');
    expect(normalizeVoidReason('x'.repeat(300))).toHaveLength(300);
  });
  test('rejects blank and over-long', () => {
    expect(normalizeVoidReason('   ')).toBeNull();
    expect(normalizeVoidReason('x'.repeat(301))).toBeNull();
  });
});

describe('salesListView (2026-10-21 FE-01)', () => {
  test('loading first', () => {
    expect(salesListView({ isLoading: true, isError: false, rowCount: 0 })).toBe('loading');
  });
  test('an error is never shown as empty', () => {
    expect(salesListView({ isLoading: false, isError: true, rowCount: 0 })).toBe('error');
  });
  test('an error wins over stale rows', () => {
    expect(salesListView({ isLoading: false, isError: true, rowCount: 3 })).toBe('error');
  });
  // CLS-6 (2026-10-31): offline with nothing saved is not "no sales yet".
  test('waiting offline with no rows is offline, not empty', () => {
    expect(salesListView({ isLoading: false, isError: false, rowCount: 0, waitingOffline: true })).toBe(
      'offline',
    );
  });
  test('empty vs list', () => {
    expect(salesListView({ isLoading: false, isError: false, rowCount: 0 })).toBe('empty');
    expect(salesListView({ isLoading: false, isError: false, rowCount: 2 })).toBe('list');
  });
});
