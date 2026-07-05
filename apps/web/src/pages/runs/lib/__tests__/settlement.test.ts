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
