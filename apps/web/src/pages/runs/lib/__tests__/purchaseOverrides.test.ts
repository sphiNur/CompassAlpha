import { describe, expect, test } from 'bun:test';
import {
  paidPerStore,
  editPricingFromSplits,
  followPaymentMethod,
  followUnitPrice,
  splitOverridesFor,
} from '../purchaseOverrides';

describe('editPricingFromSplits', () => {
  test('one store whose split says cash opens as cash, uniform', () => {
    const d = editPricingFromSplits({ unitPrice: '135000.00', paymentMethod: 'transfer' }, [
      { storeId: 'a', qty: '7.600', unitPrice: '135000.00', paymentMethod: 'cash' },
    ]);
    // what money uses (and the purchaser saw) — not the stale item value
    expect(d.paymentMethod).toBe('cash');
    expect(d.unitPrice).toBe('135000.00');
    expect(d.perStorePricing).toBe(false);
  });

  test('overrides equal to the item do not switch per-store mode on', () => {
    const d = editPricingFromSplits({ unitPrice: '100', paymentMethod: 'cash' }, [
      { storeId: 'a', qty: '1', unitPrice: '100.00', paymentMethod: 'cash' },
      { storeId: 'b', qty: '2' },
    ]);
    expect(d.perStorePricing).toBe(false);
  });

  test('stores that really differ keep per-store mode with effective values', () => {
    const d = editPricingFromSplits({ unitPrice: '100', paymentMethod: 'cash' }, [
      { storeId: 'a', qty: '1', paymentMethod: 'transfer' },
      { storeId: 'b', qty: '2' },
    ]);
    expect(d.perStorePricing).toBe(true);
    expect(d.paymentMethod).toBe('cash');
    expect([...d.splitPaymentMethods]).toEqual([
      ['a', 'transfer'],
      ['b', 'cash'],
    ]);
    expect([...d.splitPrices]).toEqual([
      ['a', '100'],
      ['b', '100'],
    ]);
  });
});

describe('splitOverridesFor', () => {
  const base = {
    perStorePricing: true,
    unitPrice: '100',
    paymentMethod: 'transfer' as const,
    splitPrices: new Map([
      ['a', '100.00'],
      ['b', '90'],
    ]),
    splitPaymentMethods: new Map([
      ['a', 'transfer' as const],
      ['b', 'cash' as const],
    ]),
  };
  test('only what differs from the item is sent', () => {
    expect(splitOverridesFor(base, 'a')).toEqual({});
    expect(splitOverridesFor(base, 'b')).toEqual({ unitPrice: '90', paymentMethod: 'cash' });
  });
  test('uniform pricing sends no overrides', () => {
    expect(splitOverridesFor({ ...base, perStorePricing: false }, 'b')).toEqual({});
  });
});

describe('follow the item-level value', () => {
  test('stores on the old method move; others keep theirs', () => {
    const next = followPaymentMethod(
      new Map([
        ['a', 'cash'],
        ['b', 'transfer'],
      ]),
      'cash',
      'transfer',
    );
    expect([...next]).toEqual([
      ['a', 'transfer'],
      ['b', 'transfer'],
    ]);
  });
  test('stores on the old price move; others keep theirs', () => {
    const next = followUnitPrice(
      new Map([
        ['a', '100.00'],
        ['b', '90'],
      ]),
      '100',
      '120',
    );
    expect([...next]).toEqual([
      ['a', '120'],
      ['b', '90'],
    ]);
  });
});

describe('paidPerStore (DX-BUY-1)', () => {
  test('splits repeating the item method are not per-store payment', () => {
    // What run.get sent a store-scoped buyer: the inherited method resolved.
    expect(
      paidPerStore({ paymentMethod: 'cash' }, [
        { storeId: 'a', qty: '1', paymentMethod: 'cash' },
        { storeId: 'b', qty: '2', paymentMethod: 'cash' },
      ]),
    ).toBe(false);
    expect(paidPerStore({ paymentMethod: 'transfer' }, [{ storeId: 'a', qty: '1' }])).toBe(false);
  });

  test('a store paid differently from the item is per-store payment', () => {
    expect(
      paidPerStore({ paymentMethod: 'cash' }, [
        { storeId: 'a', qty: '1', paymentMethod: null },
        { storeId: 'b', qty: '2', paymentMethod: 'transfer' },
      ]),
    ).toBe(true);
    // Mixed stores: the server reports no single item method.
    expect(
      paidPerStore({ paymentMethod: null }, [
        { storeId: 'a', qty: '1', paymentMethod: 'cash' },
        { storeId: 'b', qty: '2', paymentMethod: 'transfer' },
      ]),
    ).toBe(true);
  });

  test('an emptied split does not count', () => {
    expect(
      paidPerStore({ paymentMethod: 'cash' }, [
        { storeId: 'a', qty: '1' },
        { storeId: 'b', qty: '0', paymentMethod: 'transfer' },
      ]),
    ).toBe(false);
  });
});
