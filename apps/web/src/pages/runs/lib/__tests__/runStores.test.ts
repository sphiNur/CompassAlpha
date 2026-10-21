/**
 * 2026-10-21 audit CA-29: run store scope + "merge into existing row"
 * split math (C-04 / C-05).
 */
import { describe, it, expect } from 'bun:test';
import { mergeIntoPurchasedItem, mergeSplitsIntoExistingItem, runStoreIdsOf } from '../runStores';

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

describe('mergeIntoPurchasedItem (2026-10-21 FE-04)', () => {
  const item = {
    unitPrice: '1000',
    purchasedQty: '5',
    supplierId: 'sup-1',
    receiptPhotoUrl: 'r2://receipt.jpg',
    paymentMethod: 'cash',
  };
  const existingSplits = [
    { storeId: 'A', qty: '3', unitPrice: null, paymentMethod: null },
    // B was bought at its own price, by transfer.
    { storeId: 'B', qty: '2', unitPrice: '1200', paymentMethod: 'transfer' },
  ];

  it('keeps supplier, receipt and existing overrides when the draft has none', () => {
    const out = mergeIntoPurchasedItem({
      item,
      existingSplits,
      newSplits: [{ storeId: 'C', qty: '1' }],
      draft: { unitPrice: '1000', paymentMethod: 'cash', supplierId: null, receiptPhotoUrl: null },
    });
    expect(out.supplierId).toBe('sup-1');
    expect(out.receiptPhotoUrl).toBe('r2://receipt.jpg');
    expect(out.unitPrice).toBe('1000');
    expect(out.paymentMethod).toBe('cash');
    expect(out.storeSplits).toEqual([
      { storeId: 'A', qty: '3' },
      { storeId: 'B', qty: '2', unitPrice: '1200', paymentMethod: 'transfer' },
      { storeId: 'C', qty: '1' },
    ]);
    expect(out.actualQty).toBe('6');
  });

  it('records a differing draft price / payment as an override on the new store only', () => {
    const out = mergeIntoPurchasedItem({
      item,
      existingSplits,
      newSplits: [{ storeId: 'C', qty: '1.5' }],
      draft: {
        unitPrice: '1100',
        paymentMethod: 'transfer',
        supplierId: null,
        receiptPhotoUrl: 'r2://new.jpg',
      },
    });
    expect(out.unitPrice).toBe('1000');
    expect(out.receiptPhotoUrl).toBe('r2://new.jpg');
    expect(out.storeSplits[2]).toEqual({
      storeId: 'C',
      qty: '1.5',
      unitPrice: '1100',
      paymentMethod: 'transfer',
    });
    expect(out.storeSplits[0]).toEqual({ storeId: 'A', qty: '3' });
    expect(out.actualQty).toBe('6.5');
  });

  it('falls back to draft values when the row is missing them', () => {
    const out = mergeIntoPurchasedItem({
      item: { unitPrice: null, supplierId: null, receiptPhotoUrl: null, paymentMethod: null },
      existingSplits: [{ storeId: 'A', qty: '1' }],
      newSplits: [{ storeId: 'A', qty: '0.5' }],
      draft: {
        unitPrice: '700',
        paymentMethod: 'transfer',
        supplierId: 'sup-2',
        receiptPhotoUrl: null,
      },
    });
    expect(out).toEqual({
      supplierId: 'sup-2',
      unitPrice: '700',
      paymentMethod: 'transfer',
      receiptPhotoUrl: null,
      storeSplits: [{ storeId: 'A', qty: '1.5' }],
      actualQty: '1.5',
    });
  });
});
