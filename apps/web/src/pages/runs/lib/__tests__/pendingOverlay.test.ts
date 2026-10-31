import { describe, expect, test } from 'bun:test';
import {
  overlayPendingWrites,
  pendingStoreIds,
  startDeliveryBlock,
  withData,
} from '../pendingOverlay';
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

describe('withData', () => {
  test('replaces data and reads everything else through, lazily', () => {
    // TanStack Query's tracked result: non-configurable getters that record
    // which fields were read.
    const read: string[] = [];
    const query = {} as { data: number; isFetching: boolean };
    for (const [key, value] of [['data', 1], ['isFetching', true]] as const) {
      Object.defineProperty(query, key, {
        configurable: false,
        enumerable: true,
        get: () => {
          read.push(key);
          return value;
        },
      });
    }
    const wrapped = withData(query, 2);
    expect(wrapped.data).toBe(2);
    expect(read).toEqual([]);
    expect(wrapped.isFetching).toBe(true);
    expect(read).toEqual(['isFetching']);
  });
});

describe('offline expenses and added items show as pending rows (CMP-BUY-2)', () => {
  const expenseInput = {
    runId: 'run-1',
    expenseId: 'exp-1',
    label: 'Porter',
    qty: '1',
    unitPrice: '20000',
    storeSplits: [{ storeId: 'A', qty: '1' }],
    paymentMethod: 'cash',
    receiptPhotoUrl: null,
    reason: 'carried rice',
  };

  test('a queued expense is listed, marked pending', () => {
    const out = overlayPendingWrites({ ...run, expenses: [] }, [entry('run.addExpense', expenseInput)])!;
    expect(out.expenses).toHaveLength(1);
    expect(out.expenses![0]).toMatchObject({
      id: 'exp-1',
      label: 'Porter',
      qty: '1',
      unitPrice: '20000',
      pendingSync: true,
    });
  });

  test('a run without an expenses list still gets the queued one', () => {
    const out = overlayPendingWrites(run, [entry('run.addExpense', expenseInput)])!;
    expect(out.expenses?.map((e) => e.id)).toEqual(['exp-1']);
  });

  test('once the server has the expense it is not listed twice', () => {
    const synced = { ...expenseInput, id: 'exp-1', unitHint: null, addedByMemberId: 'm', addedAt: 'x' };
    const out = overlayPendingWrites({ ...run, expenses: [synced] }, [
      entry('run.addExpense', expenseInput),
    ])!;
    expect(out.expenses).toHaveLength(1);
    expect(out.expenses![0]!.pendingSync).toBeUndefined();
  });

  test('a queued added item appears bought, with its store split, marked pending', () => {
    const out = overlayPendingWrites(run, [
      entry('run.addPurchaserItem', {
        runId: 'run-1',
        skuId: 'sugar',
        supplierId: null,
        unitPrice: '9000',
        actualQty: '3',
        storeSplits: [{ storeId: 'A', qty: '3' }],
        paymentMethod: 'transfer',
        reason: 'store asked',
      }),
    ])!;
    const sugar = out.items.find((i) => i.skuId === 'sugar');
    expect(sugar).toMatchObject({
      status: 'purchased',
      purchasedQty: '3',
      unitPrice: '9000',
      paymentMethod: 'transfer',
      addedByPurchaser: true,
      pendingSync: true,
    });
    expect(out.splits.filter((s) => s.skuId === 'sugar')).toEqual([
      expect.objectContaining({ storeId: 'A', qty: '3', pendingSync: true }),
    ]);
  });

  test('an added item already on the run is left to the server', () => {
    const out = overlayPendingWrites(run, [
      entry('run.addPurchaserItem', { runId: 'run-1', skuId: 'rice', actualQty: '1', unitPrice: '1', storeSplits: [] }),
    ])!;
    expect(out.items.filter((i) => i.skuId === 'rice')).toHaveLength(1);
    expect(out.items.find((i) => i.skuId === 'rice')!.status).toBe('pending');
  });
});

describe('startDeliveryBlock (CMP-BUY-1)', () => {
  test('offline: needs the network', () => {
    expect(startDeliveryBlock(false, 0)).toBe('offline');
    expect(startDeliveryBlock(false, 3)).toBe('offline');
  });
  test('online with writes still queued: wait for them', () => {
    expect(startDeliveryBlock(true, 2)).toBe('queued');
  });
  test('online and nothing queued: can start', () => {
    expect(startDeliveryBlock(true, 0)).toBeNull();
  });
});
