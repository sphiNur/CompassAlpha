import { describe, expect, test } from 'bun:test';
import { normalizeVoidReason, summarizeSales } from '../salesSummary';

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
