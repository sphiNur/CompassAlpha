/**
 * Review RUNAPI-14: what a reader limited to some stores is sent of a run,
 * the rules run.get and run.historyDetail now share
 * (services/runReaderView.ts). Pure — runs everywhere.
 */
import { describe, expect, test } from 'bun:test';
import type { schema } from '@compass/db';
import { expensesForReader, itemsForStoreReader, splitsForReader } from '../services/runReaderView';

const A = 'store-a';
const B = 'store-b';

function item(over: Partial<ReturnType<typeof baseItem>> = {}) {
  return { ...baseItem(), ...over };
}
function baseItem() {
  return {
    skuId: 'tomato',
    status: 'purchased',
    plannedQty: '10',
    purchasedQty: '10' as string | null,
    unitPrice: '5000' as string | null,
    paymentMethod: 'cash' as string | null,
    supplierId: 'supplier-1' as string | null,
    receiptPhotoUrl: 'https://example.test/receipt.jpg' as string | null,
  };
}
function split(
  storeId: string,
  qty: string,
  over: { skuId?: string; unitPrice?: string | null; paymentMethod?: string | null } = {},
) {
  return {
    skuId: 'tomato',
    storeId,
    qty,
    unitPrice: null as string | null,
    paymentMethod: null as string | null,
    ...over,
  };
}

describe('splitsForReader', () => {
  test('an unrestricted reader gets every split as stored', () => {
    const splits = [split(A, '4'), split(B, '6')];
    expect(splitsForReader([item()], splits, null)).toEqual({ splits, hiddenSkuIds: new Set() });
  });

  test("a store reader gets their stores' splits, with what each inherits filled in", () => {
    const out = splitsForReader(
      [item()],
      [split(A, '4'), split(B, '6', { unitPrice: '4800' })],
      new Set([A]),
    );
    expect(out.splits).toEqual([split(A, '4', { unitPrice: '5000', paymentMethod: 'cash' })]);
    expect([...out.hiddenSkuIds]).toEqual(['tomato']);
  });

  test("a split's own price and payment method win over the item's", () => {
    const out = splitsForReader(
      [item()],
      [split(A, '4', { unitPrice: '4500', paymentMethod: 'transfer' })],
      new Set([A]),
    );
    expect(out.splits[0]).toMatchObject({ unitPrice: '4500', paymentMethod: 'transfer' });
    expect(out.hiddenSkuIds.size).toBe(0);
  });
});

describe('itemsForStoreReader', () => {
  const scope = new Set([A]);

  test("quantities become the reader's own; one agreed price and method show", () => {
    const { splits, hiddenSkuIds } = splitsForReader(
      [item()],
      [split(A, '2.5'), split(A, '1.5', { skuId: 'tomato' }), split(B, '6')],
      scope,
    );
    const [out] = itemsForStoreReader(
      [item()],
      splits,
      [{ skuId: 'tomato', qty: '3' }],
      hiddenSkuIds,
    );
    expect(out).toMatchObject({
      plannedQty: '3',
      purchasedQty: '4',
      unitPrice: '5000',
      paymentMethod: 'cash',
    });
  });

  test('supplier and receipt are withheld when a store the reader cannot see shares the item', () => {
    const { splits, hiddenSkuIds } = splitsForReader(
      [item()],
      [split(A, '4'), split(B, '6')],
      scope,
    );
    const [out] = itemsForStoreReader([item()], splits, [], hiddenSkuIds);
    expect(out).toMatchObject({ supplierId: null, receiptPhotoUrl: null });
  });

  test("they are kept when every split is the reader's", () => {
    const { splits, hiddenSkuIds } = splitsForReader([item()], [split(A, '4')], scope);
    const [out] = itemsForStoreReader([item()], splits, [], hiddenSkuIds);
    expect(out).toMatchObject({
      supplierId: 'supplier-1',
      receiptPhotoUrl: 'https://example.test/receipt.jpg',
    });
  });

  test('no item price or method when the visible splits differ or one has none', () => {
    const differ = itemsForStoreReader(
      [item()],
      [
        split(A, '1', { unitPrice: '5000', paymentMethod: 'cash' }),
        split(A, '1', { unitPrice: '5200', paymentMethod: 'transfer' }),
      ],
      [],
      new Set(),
    );
    expect(differ[0]).toMatchObject({ unitPrice: null, paymentMethod: null });
    const missing = itemsForStoreReader(
      [item()],
      [split(A, '1', { unitPrice: '5000' }), split(A, '1')],
      [],
      new Set(),
    );
    expect(missing[0]?.unitPrice).toBeNull();
  });

  test("an item the reader's stores neither asked for nor received is left out", () => {
    const items = [item(), item({ skuId: 'onion', status: 'pending', purchasedQty: null })];
    const out = itemsForStoreReader(items, [split(A, '4')], [], new Set());
    expect(out.map((row) => row.skuId)).toEqual(['tomato']);
  });

  test('an item not yet bought shows what the stores asked for, without price or method', () => {
    const pending = item({ status: 'pending', purchasedQty: null });
    const [out] = itemsForStoreReader(
      [pending],
      [],
      [
        { skuId: 'tomato', qty: '1.2' },
        { skuId: 'tomato', qty: '0.3' },
      ],
      new Set(),
    );
    expect(out).toMatchObject({
      plannedQty: '1.5',
      purchasedQty: null,
      unitPrice: null,
      paymentMethod: null,
    });
  });

  test('planned falls back to the bought quantity when the stores asked for none', () => {
    const [out] = itemsForStoreReader([item()], [split(A, '4')], [], new Set());
    expect(out?.plannedQty).toBe('4');
  });
});

describe('expensesForReader', () => {
  function expense(storeSplits: Array<{ storeId: string; qty: string }>) {
    const row: typeof schema.runExpensesV.$inferSelect = {
      id: 'expense-1',
      runId: 'run-1',
      orgId: 'org-1',
      label: 'Porter',
      unitHint: null,
      qty: '2',
      unitPrice: '20000',
      storeSplitsJson: storeSplits,
      paymentMethod: 'cash',
      receiptPhotoUrl: 'https://example.test/porter.jpg',
      reason: 'carry',
      addedByMemberId: 'member-1',
      addedAt: new Date('2026-11-11T08:00:00Z'),
      removedAt: null,
      removedByMemberId: null,
      removeReason: null,
    };
    return row;
  }

  test('everything for an unrestricted reader', () => {
    const [out] = expensesForReader(
      [
        expense([
          { storeId: A, qty: '1' },
          { storeId: B, qty: '1' },
        ]),
      ],
      null,
    );
    expect(out).toMatchObject({ qty: '2', receiptPhotoUrl: 'https://example.test/porter.jpg' });
    expect(out?.addedAt).toBe('2026-11-11T08:00:00.000Z');
  });

  test("a store reader gets their share, and no photo when another store's was cut", () => {
    const [out] = expensesForReader(
      [
        expense([
          { storeId: A, qty: '0.5' },
          { storeId: B, qty: '1.5' },
        ]),
      ],
      new Set([A]),
    );
    expect(out).toMatchObject({
      qty: '0.5',
      storeSplits: [{ storeId: A, qty: '0.5' }],
      receiptPhotoUrl: null,
    });
  });

  test("an expense of none of the reader's stores is left out", () => {
    expect(expensesForReader([expense([{ storeId: B, qty: '2' }])], new Set([A]))).toEqual([]);
  });
});
