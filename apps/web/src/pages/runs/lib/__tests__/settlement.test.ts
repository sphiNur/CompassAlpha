/**
 * Pins the run settlement money math. This is real money: the same
 * function feeds both the finish-confirm summary AND the history-detail
 * breakdown, so a behavior change here silently changes what the manager
 * settles per store. These tests encode the contract:
 *
 *   - flat path: no split carries an override → item-level price ×
 *     purchasedQty, allocated wholly to the item's payment method.
 *   - override path: if ANY split has its own unitPrice OR
 *     paymentMethod, the line total becomes Σ per-split subtotals and
 *     each split allocates by its own (or fallback) method.
 */
import { describe, it, expect } from 'bun:test';
import {
  splitUnitPrice,
  splitPaymentMethod,
  splitSubtotal,
  settleItemLine,
  settlePerStore,
} from '../settlement';

describe('splitUnitPrice / splitPaymentMethod fallbacks', () => {
  it('prefers the split value, falls back to the item, then null/cash', () => {
    expect(splitUnitPrice({ unitPrice: '200' }, { unitPrice: '100' })).toBe('200');
    expect(splitUnitPrice({}, { unitPrice: '100' })).toBe('100');
    expect(splitUnitPrice({}, {})).toBeNull();
    expect(splitPaymentMethod({ paymentMethod: 'transfer' }, { paymentMethod: 'cash' })).toBe('transfer');
    expect(splitPaymentMethod({}, { paymentMethod: 'transfer' })).toBe('transfer');
    expect(splitPaymentMethod({}, {})).toBe('cash');
  });
});

describe('splitSubtotal', () => {
  it('qty × effective unit price', () => {
    expect(splitSubtotal({ qty: '2', unitPrice: '150' }, { unitPrice: '100' })).toBe(300);
    expect(splitSubtotal({ qty: '2' }, { unitPrice: '100' })).toBe(200);
  });

  it('returns 0 when no price exists anywhere', () => {
    expect(splitSubtotal({ qty: '5' }, {})).toBe(0);
  });
});

describe('settleItemLine — flat path (no overrides)', () => {
  it('unitPrice × purchasedQty, all cash by default', () => {
    const r = settleItemLine(
      { unitPrice: '1000', purchasedQty: '3', paymentMethod: null },
      [{ qty: '3' }],
    );
    expect(r).toEqual({ line: 3000, cash: 3000, transfer: 0 });
  });

  it('allocates to transfer when the item method is transfer', () => {
    const r = settleItemLine(
      { unitPrice: '1000', purchasedQty: '2', paymentMethod: 'transfer' },
      [{ qty: '2' }],
    );
    expect(r).toEqual({ line: 2000, cash: 0, transfer: 2000 });
  });
});

describe('settleItemLine — override path', () => {
  it('ANY split override switches the whole line to per-split math', () => {
    // Two splits; only one carries an override price. The line becomes
    // the sum of BOTH split subtotals (the un-overridden one falls back
    // to the item price), NOT unitPrice × purchasedQty.
    const r = settleItemLine(
      { unitPrice: '100', purchasedQty: '5', paymentMethod: 'cash' },
      [
        { qty: '2', unitPrice: '150' }, // 300, cash (falls back to item method)
        { qty: '3' }, //                   300, cash (falls back to item price)
      ],
    );
    expect(r).toEqual({ line: 600, cash: 600, transfer: 0 });
  });

  it('mixes cash and transfer per split; parts sum to the line', () => {
    const r = settleItemLine(
      { unitPrice: '100', purchasedQty: '5', paymentMethod: 'cash' },
      [
        { qty: '2', paymentMethod: 'transfer' }, // 200 transfer (method override triggers path)
        { qty: '3' }, //                             300 cash
      ],
    );
    expect(r).toEqual({ line: 500, cash: 300, transfer: 200 });
    expect(r.cash + r.transfer).toBe(r.line);
  });

  it('a paymentMethod-only override still activates per-split pricing', () => {
    // Regression guard: `hasSplitOverrides` checks unitPrice OR
    // paymentMethod — a method-only override must not fall into the
    // flat path (which would ignore per-split allocation).
    const r = settleItemLine(
      { unitPrice: '10', purchasedQty: '4', paymentMethod: 'cash' },
      [
        { qty: '1', paymentMethod: 'transfer' },
        { qty: '3', paymentMethod: 'cash' },
      ],
    );
    expect(r).toEqual({ line: 40, cash: 30, transfer: 10 });
  });
});

/**
 * settlePerStore is the "who owes what" number: it drives the
 * finish-confirm sheet the manager reads before closing a run, and the
 * history detail they check afterwards. Until 2026-07-26 this loop was
 * duplicated verbatim in RunPage and RunHistory with no test at all.
 */
describe('settlePerStore', () => {
  const purchased = (skuId: string, unitPrice: string, paymentMethod?: string) => ({
    skuId,
    status: 'purchased',
    unitPrice,
    paymentMethod,
  });

  it('attributes a split to its store at the item price', () => {
    const m = settlePerStore(
      [purchased('sku-a', '100')],
      [
        { skuId: 'sku-a', storeId: 'A', qty: '2' },
        { skuId: 'sku-a', storeId: 'B', qty: '3' },
      ],
      [],
    );
    expect(m.get('A')!.total).toBe(200);
    expect(m.get('B')!.total).toBe(300);
    // No override anywhere → everything falls to the item's method (cash).
    expect(m.get('A')!.cash).toBe(200);
    expect(m.get('A')!.transfer).toBe(0);
  });

  it('lets one store have its own price without touching the other', () => {
    const m = settlePerStore(
      [purchased('sku-a', '100')],
      [
        { skuId: 'sku-a', storeId: 'A', qty: '2', unitPrice: '150' },
        { skuId: 'sku-a', storeId: 'B', qty: '2' },
      ],
      [],
    );
    expect(m.get('A')!.total).toBe(300);
    expect(m.get('B')!.total).toBe(200);
  });

  it('allocates cash vs transfer per split, and the parts sum to the total', () => {
    const m = settlePerStore(
      [purchased('sku-a', '100', 'cash')],
      [
        { skuId: 'sku-a', storeId: 'A', qty: '2', paymentMethod: 'transfer' },
        { skuId: 'sku-a', storeId: 'A', qty: '1' },
      ],
      [],
    );
    const a = m.get('A')!;
    expect(a.total).toBe(300);
    expect(a.transfer).toBe(200);
    expect(a.cash).toBe(100);
    expect(a.cash + a.transfer).toBe(a.total);
  });

  it('charges nobody for a pending or unavailable item', () => {
    const m = settlePerStore(
      [
        { skuId: 'sku-a', status: 'pending', unitPrice: null },
        { skuId: 'sku-b', status: 'unavailable', unitPrice: null },
      ],
      [
        { skuId: 'sku-a', storeId: 'A', qty: '5' },
        { skuId: 'sku-b', storeId: 'A', qty: '5' },
      ],
      [],
    );
    expect(m.size).toBe(0);
  });

  it('charges nobody for a purchased item with no price', () => {
    const m = settlePerStore(
      [{ skuId: 'sku-a', status: 'purchased', unitPrice: null }],
      [{ skuId: 'sku-a', storeId: 'A', qty: '5' }],
      [],
    );
    expect(m.size).toBe(0);
  });

  it('skips a split whose SKU is not in the run items', () => {
    const m = settlePerStore(
      [purchased('sku-a', '100')],
      [
        { skuId: 'sku-a', storeId: 'A', qty: '1' },
        { skuId: 'sku-ghost', storeId: 'A', qty: '99' },
      ],
      [],
    );
    expect(m.get('A')!.total).toBe(100);
  });

  it('counts distinct SKUs per store, not split rows', () => {
    const m = settlePerStore(
      [purchased('sku-a', '10'), purchased('sku-b', '10')],
      [
        { skuId: 'sku-a', storeId: 'A', qty: '1' },
        { skuId: 'sku-a', storeId: 'A', qty: '1' },
        { skuId: 'sku-b', storeId: 'A', qty: '1' },
      ],
      [],
    );
    expect(m.get('A')!.skuIds.size).toBe(2);
  });

  it('allocates run expenses by their own store splits, inside the total', () => {
    const m = settlePerStore(
      [purchased('sku-a', '100')],
      [{ skuId: 'sku-a', storeId: 'A', qty: '1' }],
      [
        {
          qty: '1',
          unitPrice: '5000',
          paymentMethod: 'cash',
          storeSplits: [
            { storeId: 'A', qty: '1' },
            { storeId: 'B', qty: '2' },
          ],
        },
      ],
    );
    const a = m.get('A')!;
    expect(a.expensesTotal).toBe(5000);
    expect(a.expensesCount).toBe(1);
    // Goods 100 + expense 5000 — the expense is part of total, not beside it.
    expect(a.total).toBe(5100);
    // Store B bought no goods but still owes its share of the expense.
    expect(m.get('B')!.total).toBe(10000);
    expect(m.get('B')!.skuIds.size).toBe(0);
  });

  it('sends a transfer-paid expense to the transfer bucket', () => {
    const m = settlePerStore(
      [],
      [],
      [
        {
          qty: '1',
          unitPrice: '3000',
          paymentMethod: 'transfer',
          storeSplits: [{ storeId: 'A', qty: '1' }],
        },
      ],
    );
    expect(m.get('A')!.transfer).toBe(3000);
    expect(m.get('A')!.cash).toBe(0);
  });

  it('returns an empty map for a run with nothing settled', () => {
    expect(settlePerStore([], [], []).size).toBe(0);
  });
});
