import { describe, expect, test } from 'bun:test';
import { stepDraftChange } from '../../../../hooks/useDraftChanged';
import {
  addItemDraftEdits,
  purchaseDraftCheck,
  purchaseDraftEdits,
  splitsAddUp,
  type AddItemFormDraft,
  type PurchaseFormDraft,
} from '../purchaseForm';

const purchase = (over: Partial<PurchaseFormDraft> = {}): PurchaseFormDraft => ({
  isEdit: false,
  actualQty: '10',
  unitPrice: '12000',
  supplierId: null,
  receiptPhotoUrl: null,
  reason: '',
  paymentMethod: 'cash',
  splits: new Map([
    ['store-a', '6'],
    ['store-b', '4'],
  ]),
  splitPrices: new Map(),
  splitPaymentMethods: new Map(),
  perStorePricing: false,
  ...over,
});

const addItem = (over: Partial<AddItemFormDraft> = {}): AddItemFormDraft => ({
  mode: 'expense',
  skuId: null,
  skuCostMode: 'merge',
  label: 'Ice',
  unitHint: 'bag',
  expenseScope: 'store',
  actualQty: '2',
  unitPrice: '',
  splits: new Map([['store-a', '2']]),
  paymentMethod: 'cash',
  receiptPhotoUrl: null,
  reason: 'Asked for by the store',
  ...over,
});

/** useDraftChanged, step by step: the first draft is the sheet as it opened. */
function sheet<T>(pick: (d: T) => unknown, opened: T) {
  const first = stepDraftChange(null, 'row', JSON.stringify(pick(opened)));
  return (now: T) => stepDraftChange(first.opened, 'row', JSON.stringify(pick(now))).changed;
}

describe('splitsAddUp: the server measure', () => {
  test('1.001 split against 1 does not add up (the sheets allowed 0.001)', () => {
    expect(splitsAddUp(new Map([['a', '1.001']]), '1').splitMatches).toBe(false);
  });

  test('an even split of 1 over three stores adds up', () => {
    const r = splitsAddUp(
      new Map([
        ['a', '0.333'],
        ['b', '0.333'],
        ['c', '0.334'],
      ]),
      '1',
    );
    expect(r.splitMatches).toBe(true);
    expect(r.splitTotal).toBeCloseTo(1, 9);
  });

  test('a blank store quantity counts as 0', () => {
    const r = splitsAddUp(
      new Map([
        ['a', '2.5'],
        ['b', ''],
      ]),
      '2.5',
    );
    expect(r).toEqual({ splitTotal: 2.5, splitMatches: true });
  });
});

describe('purchaseDraftCheck', () => {
  test('a complete purchase may be saved', () => {
    expect(purchaseDraftCheck(purchase())).toEqual({
      splitTotal: 10,
      splitMatches: true,
      reasonOk: true,
      canSubmit: true,
    });
  });

  test('a price with a third decimal may not, as the server refuses it', () => {
    expect(purchaseDraftCheck(purchase({ unitPrice: '12000.505' })).canSubmit).toBe(false);
  });

  test("a store's own price with a third decimal may not either", () => {
    const d = purchase({ perStorePricing: true, splitPrices: new Map([['store-b', '9.999']]) });
    expect(purchaseDraftCheck(d).canSubmit).toBe(false);
  });

  test('store quantities that do not add up say so', () => {
    const r = purchaseDraftCheck(purchase({ actualQty: '11' }));
    expect(r.splitMatches).toBe(false);
    expect(r.splitTotal).toBe(10);
    expect(r.canSubmit).toBe(false);
  });

  test('an edit needs a reason', () => {
    expect(purchaseDraftCheck(purchase({ isEdit: true })).reasonOk).toBe(false);
    expect(purchaseDraftCheck(purchase({ isEdit: true, reason: 'Wrong price' })).canSubmit).toBe(
      true,
    );
  });
});

describe('purchaseDraftEdits: what counts as an edit (RUNWEB2-07)', () => {
  test("a store's quantity, with several stores", () => {
    const opened = purchase();
    const changed = sheet(purchaseDraftEdits, opened);
    expect(
      changed({
        ...opened,
        splits: new Map([
          ['store-a', '5'],
          ['store-b', '5'],
        ]),
      }),
    ).toBe(true);
  });

  test("with one store, its quantity follows the line's, which is no edit of its own", () => {
    // The sheet copies the quantity bought into the only store right after
    // it opens.
    const opened = purchase({ splits: new Map([['store-a', '8']]) });
    const changed = sheet(purchaseDraftEdits, opened);
    expect(changed({ ...opened, splits: new Map([['store-a', '10']]) })).toBe(false);
  });

  test('moving the only store to another one', () => {
    const opened = purchase({ splits: new Map([['store-a', '10']]) });
    const changed = sheet(purchaseDraftEdits, opened);
    expect(changed({ ...opened, splits: new Map([['store-b', '10']]) })).toBe(true);
  });

  test("switching per-store pricing on changes nothing yet; a store's own price or method does", () => {
    const opened = purchase();
    const changed = sheet(purchaseDraftEdits, opened);
    // What the sheet's switch does: every store starts on the line's values.
    const perStore = {
      ...opened,
      perStorePricing: true,
      splitPrices: new Map([
        ['store-a', '12000'],
        ['store-b', '12000'],
      ]),
      splitPaymentMethods: new Map<string, 'cash' | 'transfer'>([
        ['store-a', 'cash'],
        ['store-b', 'cash'],
      ]),
    };
    expect(changed(perStore)).toBe(false);
    expect(
      changed({
        ...perStore,
        splitPrices: new Map([
          ['store-a', '12000'],
          ['store-b', '11500'],
        ]),
      }),
    ).toBe(true);
    expect(
      changed({
        ...perStore,
        splitPaymentMethods: new Map<string, 'cash' | 'transfer'>([
          ['store-a', 'cash'],
          ['store-b', 'transfer'],
        ]),
      }),
    ).toBe(true);
  });

  test('switching an edit with different store prices back to one price', () => {
    const opened = purchase({
      isEdit: true,
      perStorePricing: true,
      splitPrices: new Map([
        ['store-a', '12000'],
        ['store-b', '11500'],
      ]),
    });
    const changed = sheet(purchaseDraftEdits, opened);
    expect(changed({ ...opened, perStorePricing: false })).toBe(true);
  });
});

describe('addItemDraftEdits: what counts as an edit (RUNWEB2-07)', () => {
  test('only the payment method, on an expense opened for a store request', () => {
    // The request fills in the label, store, quantity and reason.
    const opened = addItem();
    const changed = sheet(addItemDraftEdits, opened);
    expect(changed({ ...opened, paymentMethod: 'transfer' })).toBe(true);
  });

  test('another store, the scope, or the cost mode', () => {
    const opened = addItem();
    const changed = sheet(addItemDraftEdits, opened);
    expect(changed({ ...opened, splits: new Map([['store-b', '2']]) })).toBe(true);
    expect(changed({ ...opened, expenseScope: 'shared', splits: new Map() })).toBe(true);
    expect(changed({ ...opened, skuCostMode: 'separateExpense' })).toBe(true);
  });

  test('a new shared expense being spread over every store is no edit', () => {
    const opened = addItem({ label: '', expenseScope: 'shared', splits: new Map() });
    const changed = sheet(addItemDraftEdits, opened);
    expect(
      changed({
        ...opened,
        splits: new Map([
          ['store-a', '1'],
          ['store-b', '1'],
        ]),
      }),
    ).toBe(false);
  });

  test('the quantity still counts, and the store quantities that follow it do not on their own', () => {
    const opened = addItem();
    const changed = sheet(addItemDraftEdits, opened);
    expect(changed({ ...opened, actualQty: '3', splits: new Map([['store-a', '3']]) })).toBe(true);
    expect(changed({ ...opened, splits: new Map([['store-a', '3']]) })).toBe(false);
  });
});
