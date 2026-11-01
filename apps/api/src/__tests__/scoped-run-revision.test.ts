/**
 * 2026-10-21: a store-scoped reader revising or undoing a purchase must not
 * erase the splits run.get hid from them (services/scopedRunRevision.ts),
 * and transfer audit rows must be scoped to a store (deriveScopeStoreId).
 * Pure — runs everywhere.
 */
import { describe, expect, test } from 'bun:test';
import {
  addDecimalStrings,
  hiddenSplits,
  mergeScopedRevision,
  splitsInheritingItemPayment,
  StoreOutOfScopeError,
  type ScopedRevisionInput,
  type ScopedRevisionItem,
} from '../services/scopedRunRevision';
import { deriveScopeStoreId } from '../trpc/routers/admin';

const A = 'store-a';
const B = 'store-b';
const C = 'store-c';

const item: ScopedRevisionItem = {
  supplierId: 'supplier-1',
  unitPrice: '12000',
  paymentMethod: 'cash',
  receiptPhotoUrl: 'https://cdn/receipt.jpg',
  storeSplits: [
    { storeId: A, qty: '2' },
    { storeId: B, qty: '1.5', unitPrice: '11000' },
    { storeId: C, qty: '0.25', paymentMethod: 'transfer' },
  ],
};

// What a reader scoped to store A gets back from run.get and sends again.
const visibleOnlyInput: ScopedRevisionInput & {
  runId: string;
  skuId: string;
  reason: string;
  unitPrice: string;
  paymentMethod: 'cash' | 'transfer';
} = {
  runId: 'run-1',
  skuId: 'sku-1',
  reason: 'fix price',
  unitPrice: '13000',
  paymentMethod: 'cash',
  supplierId: null,
  receiptPhotoUrl: null,
  actualQty: '3',
  storeSplits: [{ storeId: A, qty: '3' }],
};

describe('mergeScopedRevision', () => {
  test('unrestricted actors are untouched', () => {
    expect(mergeScopedRevision(item, visibleOnlyInput, null)).toBe(visibleOnlyInput);
  });

  test('nothing hidden → untouched', () => {
    const all = new Set([A, B, C]);
    expect(mergeScopedRevision(item, visibleOnlyInput, all)).toBe(visibleOnlyInput);
  });

  test('hidden splits survive with their effective price and payment', () => {
    const merged = mergeScopedRevision(item, visibleOnlyInput, new Set([A]));
    expect(merged.storeSplits).toEqual([
      { storeId: A, qty: '3' },
      // no override before → the item-level values become explicit, so the
      // new item price (13000) doesn't reprice store B or C
      { storeId: B, qty: '1.5', unitPrice: '11000', paymentMethod: 'cash' },
      { storeId: C, qty: '0.25', unitPrice: '12000', paymentMethod: 'transfer' },
    ]);
    expect(merged.actualQty).toBe('4.75');
    expect(merged.unitPrice).toBe('13000');
  });

  test('supplier and receipt the actor was shown as null are kept', () => {
    const merged = mergeScopedRevision(item, visibleOnlyInput, new Set([A]));
    expect(merged.supplierId).toBe('supplier-1');
    expect(merged.receiptPhotoUrl).toBe('https://cdn/receipt.jpg');
  });

  test('a new receipt or supplier from the actor still wins', () => {
    const merged = mergeScopedRevision(
      item,
      { ...visibleOnlyInput, supplierId: 'supplier-2', receiptPhotoUrl: 'https://cdn/new.jpg' },
      new Set([A]),
    );
    expect(merged.supplierId).toBe('supplier-2');
    expect(merged.receiptPhotoUrl).toBe('https://cdn/new.jpg');
  });

  test('a split for a store outside the scope is refused', () => {
    expect(() =>
      mergeScopedRevision(
        item,
        { ...visibleOnlyInput, storeSplits: [{ storeId: B, qty: '3' }] },
        new Set([A]),
      ),
    ).toThrow(StoreOutOfScopeError);
  });

  test('the merged split sum equals actualQty', () => {
    const merged = mergeScopedRevision(item, visibleOnlyInput, new Set([A, B]));
    expect(addDecimalStrings(merged.storeSplits.map((s) => s.qty))).toBe(merged.actualQty);
  });
});

describe('splitsInheritingItemPayment (DX-BUY-1)', () => {
  test('splits paid like the item read as inherited (null)', () => {
    const out = splitsInheritingItemPayment(
      [{ skuId: 's1', paymentMethod: 'cash' }],
      [
        { skuId: 's1', storeId: A, paymentMethod: 'cash' as string | null },
        { skuId: 's1', storeId: B, paymentMethod: 'cash' as string | null },
      ],
    );
    expect(out.map((split) => split.paymentMethod)).toEqual([null, null]);
    expect(out.map((split) => split.storeId)).toEqual([A, B]);
  });

  test('rows paid per store keep their methods', () => {
    const splits = [
      { skuId: 's1', storeId: A, paymentMethod: 'cash' as string | null },
      { skuId: 's1', storeId: B, paymentMethod: 'transfer' as string | null },
    ];
    expect(splitsInheritingItemPayment([{ skuId: 's1', paymentMethod: null }], splits)).toEqual(
      splits,
    );
  });
});

describe('hiddenSplits', () => {
  test('lists only stores outside the scope; none when unrestricted', () => {
    expect(hiddenSplits(item, new Set([A, C])).map((s) => s.storeId)).toEqual([B]);
    expect(hiddenSplits(item, null)).toEqual([]);
  });
});

describe('addDecimalStrings', () => {
  test('exact decimal addition', () => {
    expect(addDecimalStrings(['0.1', '0.2'])).toBe('0.3');
    expect(addDecimalStrings(['3', '1.5', '0.25'])).toBe('4.75');
    expect(addDecimalStrings(['1.50', '0.50'])).toBe('2');
    expect(addDecimalStrings([])).toBe('0');
  });
});

describe('deriveScopeStoreId — member transfers', () => {
  test('a transfer is scoped to its destination store', () => {
    expect(
      deriveScopeStoreId('admin.memberTransferStore', 'member', {
        memberId: 'm-1',
        fromStoreId: A,
        toStoreId: B,
        mirrorRoles: true,
      }),
    ).toBe(B);
  });

  test('existing keys keep their priority', () => {
    expect(deriveScopeStoreId('x', 'member', { storeId: A, toStoreId: B })).toBe(A);
    expect(deriveScopeStoreId('x', 'member', { targetStoreId: C })).toBe(C);
    expect(deriveScopeStoreId('x', 'role', { name: 'r' })).toBeNull();
  });
});
