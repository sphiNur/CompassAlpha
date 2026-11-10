import { describe, expect, test } from 'bun:test';
import {
  withoutPrices,
  canSeePrices,
  pricesVisibleAnywhere,
  pricesVisibleFor,
} from '../services/priceRedaction';

describe('withoutPrices (staff see no money)', () => {
  test('money fields go null, price maps empty, quantities and counts stay', () => {
    const run = {
      id: 'r1',
      actualTotal: '100.00',
      money: { itemsTotal: '90', expensesTotal: '10', total: '100' },
      storeTotals: [{ storeId: 's1', total: '100', cash: '40', transfer: '60', itemCount: 5 }],
      items: [{ skuId: 'k1', unitPrice: '12000', plannedQty: '3', purchasedQty: '3' }],
      expenses: [{ id: 'e1', unitPrice: '20000', qty: '1', storeSplits: [{ storeId: 's1', qty: '1' }] }],
      sessions: [{ id: 'x', totalQty: '7', itemCount: 2 }],
      lastPriceBySku: { k1: '12000' },
      lastPriceObservedAtBySku: { k1: '2026-10-29' },
      startedAt: new Date('2026-10-30T00:00:00Z'),
    };
    // The redacted copy breaks the input's types on purpose (strings → null),
    // so it is compared as unknown.
    const out: unknown = withoutPrices(run);
    expect(out).toEqual({
      id: 'r1',
      actualTotal: null,
      money: { itemsTotal: null, expensesTotal: null, total: null },
      storeTotals: [{ storeId: 's1', total: null, cash: null, transfer: null, itemCount: 5 }],
      items: [{ skuId: 'k1', unitPrice: null, plannedQty: '3', purchasedQty: '3' }],
      expenses: [
        { id: 'e1', unitPrice: null, qty: '1', storeSplits: [{ storeId: 's1', qty: '1' }] },
      ],
      sessions: [{ id: 'x', totalQty: '7', itemCount: 2 }],
      lastPriceBySku: {},
      lastPriceObservedAtBySku: {},
      startedAt: run.startedAt,
    });
  });

  test('prices.view decides', () => {
    expect(canSeePrices({ permissions: new Set(['prices.view']) })).toBe(true);
    expect(canSeePrices({ permissions: new Set(['order.draft']) })).toBe(false);
    expect(canSeePrices(null)).toBe(false);
  });

  test('D6: money for a set of stores needs prices.view in every one of them', () => {
    expect(pricesVisibleFor(null, ['a', 'b'])).toBe(true);
    expect(pricesVisibleFor(['a', 'b'], ['a', 'b'])).toBe(true);
    // Manager at B, staff at A: a run or total over A and B shows no money.
    expect(pricesVisibleFor(['b'], ['a', 'b'])).toBe(false);
    expect(pricesVisibleFor(['b'], ['a'])).toBe(false);
    expect(pricesVisibleFor([], ['a'])).toBe(false);
    // Money tied to no store yet follows "anywhere".
    expect(pricesVisibleFor(['b'], [])).toBe(true);
    expect(pricesVisibleFor([], [])).toBe(false);
    expect(pricesVisibleAnywhere(null)).toBe(true);
    expect(pricesVisibleAnywhere(['a'])).toBe(true);
    expect(pricesVisibleAnywhere([])).toBe(false);
  });

  test('D6: estimates and price hints are redacted too', () => {
    const out: unknown = withoutPrices({
      estimatedTotal: '10',
      estimatedCash: '4',
      estimatedTransfer: '6',
      estimatedKnown: 2,
      lineTotal: '5.00',
      qty: '2',
      lastPurchasePriceBySku: { k: '1' },
    });
    expect(out).toEqual({
      estimatedTotal: null,
      estimatedCash: null,
      estimatedTransfer: null,
      estimatedKnown: 2,
      lineTotal: null,
      qty: '2',
      lastPurchasePriceBySku: {},
    });
  });
});
