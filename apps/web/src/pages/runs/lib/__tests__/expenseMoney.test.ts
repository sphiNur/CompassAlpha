import { describe, expect, test } from 'bun:test';
import { expenseLine, expensesTotal } from '../expenseMoney';

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
});
