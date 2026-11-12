import { describe, expect, test } from 'bun:test';
import type { ActiveRun } from '../../types';
import { newAddItemDraft, planAddItemSubmit, type AddItemContext } from '../addItem';

type Item = ActiveRun['items'][number];
type Split = ActiveRun['splits'][number];

const item = (skuId: string, over: Partial<Item> = {}): Item => ({
  skuId,
  plannedQty: '2',
  purchasedQty: null,
  status: 'pending',
  unavailableNote: null,
  unitPrice: null,
  ...over,
});
const split = (skuId: string, storeId: string, qty: string, over: Partial<Split> = {}): Split => ({
  runId: 'run',
  skuId,
  storeId,
  qty,
  deliveredAt: null,
  confirmedAt: null,
  ...over,
});

const ctx = (run: AddItemContext['run'], over: Partial<AddItemContext> = {}): AddItemContext => ({
  run,
  product: (skuId) => (skuId === 'ghost' ? null : { name: `name:${skuId}`, unit: 'kg' }),
  crossStoreReason: 'cross-store',
  ...over,
});

/** The sheet with a product, a price and one store's quantity typed. */
const productDraft = (skuId: string | null, store = 'B', qty = '1') => ({
  ...newAddItemDraft('run'),
  skuId,
  unitPrice: '50',
  actualQty: qty,
  splits: new Map([[store, qty]]),
  reason: '  chef asked  ',
});

describe('newAddItemDraft', () => {
  test('an empty product form with an expense id ready', () => {
    const d = newAddItemDraft('run');
    expect(d).toMatchObject({
      mode: 'sku',
      runId: 'run',
      skuId: null,
      skuCostMode: 'merge',
      expenseScope: 'shared',
      actualQty: '',
      paymentMethod: 'cash',
      reason: '',
    });
    expect(d.expenseId).not.toBe('');
    expect(newAddItemDraft('run').expenseId).not.toBe(d.expenseId);
  });

  test('a way in sets its own fields and keeps the id it brings', () => {
    const d = newAddItemDraft('run', {
      mode: 'expense',
      expenseId: 'e1',
      label: 'Napkins',
      expenseScope: 'store',
      splits: new Map([['A', '2']]),
    });
    expect(d).toMatchObject({
      mode: 'expense',
      expenseId: 'e1',
      label: 'Napkins',
      expenseScope: 'store',
    });
    expect([...d.splits]).toEqual([['A', '2']]);
  });
});

describe('planAddItemSubmit', () => {
  test('nothing to send without a product, or an expense without a name', () => {
    expect(planAddItemSubmit(productDraft(null), ctx(undefined))).toBeNull();
    expect(
      planAddItemSubmit(
        { ...newAddItemDraft('run', { mode: 'expense' }), label: '  ' },
        ctx(undefined),
      ),
    ).toBeNull();
  });

  test('a product new to the run is a row the purchaser added', () => {
    const c = planAddItemSubmit(productDraft('bread'), ctx({ items: [], splits: [] }));
    expect(c).toEqual({
      procedure: 'addPurchaserItem',
      input: {
        runId: 'run',
        skuId: 'bread',
        supplierId: null,
        unitPrice: '50',
        actualQty: '1',
        receiptPhotoUrl: null,
        storeSplits: [{ storeId: 'B', qty: '1' }],
        paymentMethod: 'cash',
        reason: 'chef asked',
      },
    });
  });

  test('stores with nothing typed are left out', () => {
    const d = {
      ...productDraft('bread'),
      splits: new Map([
        ['A', '0'],
        ['B', '1'],
        ['C', ''],
      ]),
    };
    const c = planAddItemSubmit(d, ctx({ items: [], splits: [] }));
    expect(c?.procedure === 'addPurchaserItem' && c.input.storeSplits).toEqual([
      { storeId: 'B', qty: '1' },
    ]);
  });

  test('a new store on a pending row buys it for the stores that ordered it too', () => {
    const c = planAddItemSubmit(
      productDraft('tomato'),
      ctx(
        {
          items: [item('tomato')],
          splits: [],
          perStoreDemand: [{ storeId: 'A', skuId: 'tomato', qty: '2' }],
        },
        { priceConfirmed: true },
      ),
    );
    expect(c).toEqual({
      procedure: 'purchaseItem',
      input: {
        runId: 'run',
        skuId: 'tomato',
        supplierId: null,
        unitPrice: '50',
        actualQty: '3',
        receiptPhotoUrl: null,
        storeSplits: [
          { storeId: 'A', qty: '2' },
          { storeId: 'B', qty: '1' },
        ],
        paymentMethod: 'cash',
        priceConfirmed: true,
      },
    });
  });

  test('a new store on a bought row revises it and keeps the row as bought', () => {
    const c = planAddItemSubmit(
      { ...productDraft('tomato'), reason: '' },
      ctx({
        items: [
          item('tomato', {
            status: 'purchased',
            purchasedQty: '2',
            unitPrice: '40',
            paymentMethod: 'transfer',
            supplierId: 'stall',
          }),
        ],
        splits: [split('tomato', 'A', '2')],
      }),
    );
    expect(c?.procedure).toBe('revisePurchase');
    expect(c?.procedure === 'revisePurchase' && c.input).toMatchObject({
      runId: 'run',
      skuId: 'tomato',
      supplierId: 'stall',
      unitPrice: '40',
      paymentMethod: 'transfer',
      actualQty: '3',
      // An empty reason takes the catalog's cross-store one.
      reason: 'cross-store',
    });
  });

  test('a store that already has the product records a separate cost', () => {
    const c = planAddItemSubmit(
      productDraft('tomato', 'A'),
      ctx({ items: [item('tomato')], splits: [split('tomato', 'A', '2')] }),
    );
    expect(c).toEqual({
      procedure: 'addExpense',
      input: {
        runId: 'run',
        expenseId: expect.any(String),
        label: 'name:tomato',
        unitHint: 'kg',
        qty: '1',
        unitPrice: '50',
        storeSplits: [{ storeId: 'A', qty: '1' }],
        paymentMethod: 'cash',
        receiptPhotoUrl: null,
        reason: 'chef asked',
      },
    });
  });

  test('so does a product on the run when the purchaser chose a separate cost', () => {
    const c = planAddItemSubmit(
      { ...productDraft('tomato'), skuCostMode: 'separateExpense' },
      ctx({ items: [item('tomato')], splits: [] }),
    );
    expect(c?.procedure).toBe('addExpense');
  });

  test('a product not in the list saves nothing (RUNWEB1-38)', () => {
    const c = planAddItemSubmit(
      { ...productDraft('ghost'), skuCostMode: 'separateExpense' },
      ctx({ items: [item('ghost')], splits: [] }),
    );
    expect(c).toEqual({ procedure: 'missingProduct' });
  });

  test('an unavailable row falls through to a new row, as before', () => {
    const c = planAddItemSubmit(
      productDraft('salt'),
      ctx({ items: [item('salt', { status: 'unavailable' })], splits: [] }),
    );
    expect(c?.procedure).toBe('addPurchaserItem');
  });

  test('the expense tab records an expense with its name and unit trimmed', () => {
    const d = {
      ...newAddItemDraft('run', { mode: 'expense', expenseId: 'e1' }),
      label: ' Taxi ',
      unitHint: ' trip ',
      actualQty: '1',
      unitPrice: '20',
      splits: new Map([['A', '1']]),
    };
    expect(planAddItemSubmit(d, ctx(undefined))).toEqual({
      procedure: 'addExpense',
      input: {
        runId: 'run',
        expenseId: 'e1',
        label: 'Taxi',
        unitHint: 'trip',
        qty: '1',
        unitPrice: '20',
        storeSplits: [{ storeId: 'A', qty: '1' }],
        paymentMethod: 'cash',
        receiptPhotoUrl: null,
        reason: '',
      },
    });
    const noUnit = planAddItemSubmit({ ...d, unitHint: '  ' }, ctx(undefined));
    expect(noUnit?.procedure === 'addExpense' && 'unitHint' in noUnit.input).toBe(false);
  });
});
