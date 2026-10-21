/**
 * 2026-10-21 audit CA-29: run store scope + "merge into existing row"
 * split math (C-04 / C-05).
 */
import { describe, it, expect } from 'bun:test';
import { mergeSplitsIntoExistingItem, runStoreIdsOf } from '../runStores';

describe('runStoreIdsOf', () => {
  it('unions sessions, demand and splits without duplicates', () => {
    expect(
      runStoreIdsOf({
        sessions: [{ storeId: 'A' }, { storeId: 'B' }],
        perStoreDemand: [{ storeId: 'B' }],
        splits: [{ storeId: 'C' }],
      }).sort(),
    ).toEqual(['A', 'B', 'C']);
  });

  it('is empty for a missing run', () => {
    expect(runStoreIdsOf(undefined)).toEqual([]);
  });
});

describe('mergeSplitsIntoExistingItem', () => {
  it('keeps the other stores’ demand when merging into a pending row', () => {
    // SKU ordered 5 by A (still pending); purchaser adds 2 for C.
    const out = mergeSplitsIntoExistingItem({
      status: 'pending',
      existingSplits: [],
      demand: [{ storeId: 'A', qty: '5' }],
      newSplits: [{ storeId: 'C', qty: '2' }],
    });
    expect(out.splits).toEqual([
      { storeId: 'A', qty: '5' },
      { storeId: 'C', qty: '2' },
    ]);
    expect(out.totalQty).toBe('7');
  });

  it('builds on the recorded splits for a purchased row, ignoring demand', () => {
    const out = mergeSplitsIntoExistingItem({
      status: 'purchased',
      existingSplits: [{ storeId: 'A', qty: '4.5' }],
      demand: [{ storeId: 'A', qty: '5' }],
      newSplits: [{ storeId: 'C', qty: '1' }],
    });
    expect(out.splits).toEqual([
      { storeId: 'A', qty: '4.5' },
      { storeId: 'C', qty: '1' },
    ]);
    expect(out.totalQty).toBe('5.5');
  });

  it('sums a store present in both base and new splits, and the total matches', () => {
    const out = mergeSplitsIntoExistingItem({
      status: 'pending',
      existingSplits: [],
      demand: [
        { storeId: 'A', qty: '0.1' },
        { storeId: 'B', qty: '0.2' },
      ],
      newSplits: [{ storeId: 'B', qty: '0.1' }],
    });
    expect(out.splits).toEqual([
      { storeId: 'A', qty: '0.1' },
      { storeId: 'B', qty: '0.3' },
    ]);
    expect(out.totalQty).toBe('0.4');
  });
});
