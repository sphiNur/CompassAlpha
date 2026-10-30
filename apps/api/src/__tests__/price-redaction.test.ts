import { describe, expect, test } from 'bun:test';
import { withoutPrices, canSeePrices } from '../services/priceRedaction';

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
    // The redacted copy breaks the input's types on purpose (strings → null).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = withoutPrices(run) as any;
    expect(out.actualTotal).toBeNull();
    expect(out.money).toEqual({ itemsTotal: null, expensesTotal: null, total: null });
    expect(out.storeTotals[0]).toEqual({ storeId: 's1', total: null, cash: null, transfer: null, itemCount: 5 });
    expect(out.items[0]).toEqual({ skuId: 'k1', unitPrice: null, plannedQty: '3', purchasedQty: '3' });
    expect(out.expenses[0].unitPrice).toBeNull();
    expect(out.expenses[0].qty).toBe('1');
    expect(out.sessions[0]).toEqual({ id: 'x', totalQty: '7', itemCount: 2 });
    expect(out.lastPriceBySku).toEqual({});
    expect(out.lastPriceObservedAtBySku).toEqual({});
    expect(out.startedAt).toEqual(run.startedAt);
  });

  test('prices.view decides', () => {
    expect(canSeePrices({ permissions: new Set(['prices.view']) })).toBe(true);
    expect(canSeePrices({ permissions: new Set(['order.draft']) })).toBe(false);
    expect(canSeePrices(null)).toBe(false);
  });
});
