import { describe, expect, test } from 'bun:test';
import {
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
