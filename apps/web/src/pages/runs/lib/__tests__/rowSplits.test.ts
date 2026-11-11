/**
 * Review RUNWEB1-07: a memo()'d purchase row is handed the same arrays
 * until the run changes.
 */
import { describe, expect, it } from 'bun:test';
import { rowSplitsOf } from '../rowSplits';
import type { ActiveRun } from '../../types';

const split = (skuId: string, storeId: string, qty: string, extra: object = {}) => ({
  runId: 'r1',
  skuId,
  storeId,
  qty,
  deliveredAt: null,
  confirmedAt: null,
  ...extra,
});

describe('rowSplitsOf', () => {
  const splits: ActiveRun['splits'] = [
    split('apple', 'A', '2', { unitPrice: '12000', paymentMethod: 'cash', confirmStatus: 'ok' }),
    split('beef', 'A', '1'),
    split('apple', 'B', '3', { unitPrice: '13000', paymentMethod: 'transfer' }),
  ];

  it("lists the SKU's splits in the row's shape, in order", () => {
    expect(rowSplitsOf(splits, 'apple')).toEqual([
      { storeId: 'A', qty: '2', unitPrice: '12000', paymentMethod: 'cash' },
      { storeId: 'B', qty: '3', unitPrice: '13000', paymentMethod: 'transfer' },
    ]);
    expect(rowSplitsOf(splits, 'beef')).toEqual([
      { storeId: 'A', qty: '1', unitPrice: undefined, paymentMethod: undefined },
    ]);
  });

  it('hands out the same array for the same splits, and for none', () => {
    expect(rowSplitsOf(splits, 'apple')).toBe(rowSplitsOf(splits, 'apple'));
    expect(rowSplitsOf(splits, 'pear')).toEqual([]);
    expect(rowSplitsOf(splits, 'pear')).toBe(rowSplitsOf([], 'apple'));
  });

  it('groups a fetched-again run afresh', () => {
    const next = [...splits.slice(0, 2), split('apple', 'B', '4')];
    expect(rowSplitsOf(next, 'apple')).not.toBe(rowSplitsOf(splits, 'apple'));
    expect(rowSplitsOf(next, 'apple').map((s) => s.qty)).toEqual(['2', '4']);
  });
});
