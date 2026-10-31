import { describe, expect, test } from 'bun:test';
import { overlayPendingWrites, pendingStoreIds } from '../pendingOverlay';
import type { PendingWrite } from '../../../../hooks/useOfflineQueue';

const run = {
  id: 'run-1',
  items: [
    { skuId: 'rice', status: 'pending', purchasedQty: null, unitPrice: null, unavailableNote: null },
    { skuId: 'salt', status: 'pending', purchasedQty: null, unitPrice: null, unavailableNote: null },
  ],
  splits: [
    {
      runId: 'run-1',
      skuId: 'onion',
      storeId: 'A',
      qty: '2',
      deliveredAt: null,
      confirmedAt: null,
    },
    {
      runId: 'run-1',
      skuId: 'milk',
      storeId: 'A',
      qty: '6',
      deliveredAt: '2026-10-31T07:00:00Z',
      confirmedAt: null,
    },
  ],
};

let seq = 0;
const entry = (procedure: string, input: Record<string, unknown>): PendingWrite => ({
  clientSeq: ++seq,
  procedure,
  input,
  enqueuedAt: Date.UTC(2026, 9, 31, 8),
});

describe('overlayPendingWrites (R2-INT-1 / RE-DLV-1 / RE-DLV-4 / R2-DLV-3)', () => {
  test('nothing queued for this run → the same object', () => {
    expect(overlayPendingWrites(run, [])).toBe(run);
    expect(
      overlayPendingWrites(run, [entry('run.purchaseItem', { runId: 'other', skuId: 'rice' })]),
    ).toBe(run);
    expect(overlayPendingWrites(undefined, [])).toBeUndefined();
  });

  test('a queued purchase shows the item bought and waiting, with its splits', () => {
    const out = overlayPendingWrites(run, [
      entry('run.purchaseItem', {
        runId: 'run-1',
        skuId: 'rice',
        actualQty: '3',
        unitPrice: '12000',
        paymentMethod: 'transfer',
        storeSplits: [{ storeId: 'A', qty: '3' }],
      }),
    ])!;
    expect(out.items[0]).toMatchObject({
      status: 'purchased',
      purchasedQty: '3',
      unitPrice: '12000',
      paymentMethod: 'transfer',
      pendingSync: true,
    });
    expect(out.items[1]!.pendingSync).toBeUndefined();
    expect(out.splits.filter((sp) => sp.skuId === 'rice')).toEqual([
      expect.objectContaining({ storeId: 'A', qty: '3', pendingSync: true }),
    ]);
  });

  test('a queued "unavailable" marks the item', () => {
    const out = overlayPendingWrites(run, [
      entry('run.markUnavailable', { runId: 'run-1', skuId: 'salt', note: 'sold out' }),
    ])!;
    expect(out.items[1]).toMatchObject({
      status: 'unavailable',
      unavailableNote: 'sold out',
      pendingSync: true,
    });
  });

  test('a queued delivery shows the store delivered and waiting', () => {
    const out = overlayPendingWrites(run, [
      entry('run.deliverToStore', { runId: 'run-1', storeId: 'A' }),
    ])!;
    expect(out.splits[0]).toMatchObject({ deliveredAt: '2026-10-31T08:00:00.000Z', pendingSync: true });
    // Already delivered splits are left as the server has them.
    expect(out.splits[1]!.deliveredAt).toBe('2026-10-31T07:00:00Z');
  });

  test('queued verdicts, "all OK" and the receipt confirmation', () => {
    const out = overlayPendingWrites(run, [
      entry('run.confirmStoreItem', {
        runId: 'run-1',
        storeId: 'A',
        skuId: 'milk',
        status: 'short',
        note: 'one missing',
        photoUrl: null,
        receivedQty: '5',
      }),
      entry('run.markStoreItemsOk', { runId: 'run-1', storeId: 'A', skuIds: ['onion', 'milk'] }),
      entry('run.confirmStore', { runId: 'run-1', storeId: 'A' }),
    ])!;
    const milk = out.splits.find((sp) => sp.skuId === 'milk')!;
    // "All OK" does not overwrite a verdict already given.
    expect(milk).toMatchObject({ confirmStatus: 'short', confirmReceivedQty: '5' });
    expect(milk.confirmedAt).toBeTruthy();
    const onion = out.splits.find((sp) => sp.skuId === 'onion')!;
    expect(onion.confirmStatus).toBe('ok');
    // Not delivered yet → the queued confirmation cannot cover it.
    expect(onion.confirmedAt).toBeNull();
  });

  test('pendingStoreIds names the stores with a queued step', () => {
    const entries = [
      entry('run.confirmStore', { runId: 'run-1', storeId: 'A' }),
      entry('run.deliverToStore', { runId: 'run-1', storeId: 'B' }),
      entry('run.confirmStore', { runId: 'run-2', storeId: 'C' }),
    ];
    expect([...pendingStoreIds('run-1', entries, 'run.confirmStore')]).toEqual(['A']);
    expect([...pendingStoreIds('run-1', entries, 'run.deliverToStore')]).toEqual(['B']);
    expect(pendingStoreIds(undefined, entries, 'run.confirmStore').size).toBe(0);
  });
});
