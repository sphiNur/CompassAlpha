import { describe, expect, test } from 'bun:test';
import { expenseLine, expensesTotal } from '../expenseMoney';
import { expenseLine as settlementExpenseLine } from '../settlement';

describe('expense money (DX-HIS-2)', () => {
  test('a hidden price shows no amount instead of 0', () => {
    expect(expenseLine({ qty: '1', unitPrice: null })).toBeNull();
    expect(expensesTotal([{ qty: '1', unitPrice: null }])).toBeNull();
    expect(
      expensesTotal([
        { qty: '1', unitPrice: '40000' },
        { qty: '2', unitPrice: null },
      ]),
    ).toBeNull();
  });

  test('lines are rounded to cents and added in cents (D1)', () => {
    expect(expenseLine({ qty: '0.333', unitPrice: '30000' })).toBe('9990.00');
    expect(expenseLine({ qty: '1.005', unitPrice: '0.5' })).toBe('0.50');
    expect(
      expensesTotal([
        { qty: '0.1', unitPrice: '0.1' },
        { qty: '0.2', unitPrice: '0.1' },
      ]),
    ).toBe('0.03');
    expect(expensesTotal([])).toBe('0.00');
  });

  test('a shared expense is one line per store, as on the settlement sheet (RUNWEB2-02)', () => {
    const shared = {
      qty: '1',
      unitPrice: '12345',
      storeSplits: [
        { storeId: 'A', qty: '0.333' },
        { storeId: 'B', qty: '0.333' },
        { storeId: 'C', qty: '0.334' },
      ],
    };
    // 4110.89 + 4110.89 + 4123.23; the card used to say 12345.00.
    expect(expenseLine(shared)).toBe('12345.01');
    expect(settlementExpenseLine(shared)).toBe(12345.01);
    expect(expensesTotal([shared])).toBe('12345.01');
    // A store's own price counts for its share.
    expect(
      expenseLine({
        qty: '2',
        unitPrice: '100',
        storeSplits: [{ qty: '1', unitPrice: '90' }, { qty: '1' }],
      }),
    ).toBe('190.00');
  });
});
