// Quantity arithmetic lives in @compass/contracts (no test runner types
// there); the run reducer and the API's demand sums use it (RUNAPI-05).
import { describe, expect, it } from 'bun:test';
import {
  addQty,
  milliQty,
  milliQtyFixed,
  mulQty,
  normalizeQty,
  qtyMilli,
  qtyMilliOrZero,
  qtyTotalsBySku,
  subQty,
  sumQty,
} from '@compass/contracts';

describe('quantity arithmetic (RUNAPI-05)', () => {
  it('adds without float noise', () => {
    expect(0.1 + 0.2).not.toBe(0.3); // the bug this replaces
    expect(addQty('0.1', '0.2')).toBe('0.3');
    expect(addQty('1.1', '0.2')).toBe('1.3');
    expect(addQty('0.7', '0.2')).toBe('0.9');
    expect(sumQty(['0.1', '0.2', '0.3'])).toBe('0.6');
    // Mixed scales and trailing zeros (scopedRunRevision's own adder, RUNAPI-14).
    expect(sumQty(['3', '1.5', '0.25'])).toBe('4.75');
    expect(sumQty(['1.50', '0.50'])).toBe('2');
    expect(subQty('0.3', '0.2')).toBe('0.1');
    expect(subQty('0.3', '0.3')).toBe('0');
  });

  it('prints like String(Number(q)) for clean values', () => {
    for (const q of ['0', '1', '2.5', '0.333', '12', '1000000', '0.001', '123456789.125']) {
      expect(normalizeQty(q)).toBe(String(Number(q)));
    }
    expect(normalizeQty('1.500')).toBe('1.5');
    expect(normalizeQty('3.000')).toBe('3');
    expect(normalizeQty('.5')).toBe('0.5');
    expect(milliQty(-100n)).toBe('-0.1');
  });

  it('rounds past 3 decimals half away from zero', () => {
    expect(normalizeQty('0.30000000000000004')).toBe('0.3');
    expect(normalizeQty('0.10000000000000003')).toBe('0.1');
    expect(normalizeQty('0.8999999999999999')).toBe('0.9');
    expect(normalizeQty('0.0005')).toBe('0.001');
    expect(normalizeQty('0.0004')).toBe('0');
    expect(normalizeQty(0.1 + 0.2)).toBe('0.3');
    expect(qtyMilli('2.5')).toBe(2500n);
  });

  it('skips empty values and refuses text that is not a number', () => {
    expect(sumQty([])).toBe('0');
    expect(sumQty(['1', null, undefined, '', '2'])).toBe('3');
    expect(() => qtyMilli('abc')).toThrow(RangeError);
    expect(() => qtyMilli('1e3')).toThrow(RangeError);
  });

  it('reads a stored or half-typed quantity without throwing (RUNWEB2-14)', () => {
    expect(qtyMilliOrZero('2.5')).toBe(2500n);
    expect(qtyMilliOrZero('0.30000000000000004')).toBe(300n);
    expect(qtyMilliOrZero(0.1 + 0.2)).toBe(300n);
    expect(qtyMilliOrZero('-1.5')).toBe(-1500n);
    // Not a plain decimal: read through Number, as before.
    expect(qtyMilliOrZero('1e3')).toBe(1_000_000n);
    for (const value of [null, undefined, '', 'abc', '1,5', 'NaN', Infinity]) {
      expect(qtyMilliOrZero(value)).toBe(0n);
    }
  });

  it('prints all three decimals when asked (QTY-03)', () => {
    expect(milliQtyFixed(1500n)).toBe('1.500');
    expect(milliQtyFixed(-250n)).toBe('-0.250');
    expect(milliQtyFixed(0n)).toBe('0.000');
    expect(milliQtyFixed(7n)).toBe('0.007');
    expect(milliQtyFixed(123456789n)).toBe('123456.789');
    expect(milliQty(1500n)).toBe('1.5');
  });

  it('totals each product over its lines, exactly (QTY-01)', () => {
    const totals = qtyTotalsBySku([
      { skuId: 'apple', qty: '0.1' },
      { skuId: 'pear', qty: '0' },
      { skuId: 'apple', qty: '0.2' },
      { skuId: 'plum', qty: '1.5' },
      { skuId: 'pear', qty: null },
      { skuId: 'plum', qty: '0.30000000000000004' },
    ]);
    // 0.1 + 0.2 is 0.3 exactly; pear has no line above 0; first-line order.
    expect([...totals]).toEqual([
      ['apple', 300n],
      ['plum', 1800n],
    ]);
    expect(qtyTotalsBySku([]).size).toBe(0);
  });

  it('multiplies exactly and rounds once, half away from zero (CONF-15)', () => {
    expect((1.0005 * 1).toFixed(3)).toBe('1.000'); // the float rounding this replaces
    expect(mulQty('1.0005', '1')).toBe('1.001');
    expect(mulQty('0.0045', '1')).toBe('0.005');
    expect(mulQty('0.25', '3')).toBe('0.75');
    expect(mulQty('0.1235', '10')).toBe('1.235');
    expect(mulQty('2.5', '0.33')).toBe('0.825');
    expect(mulQty('0.0125', '0.5')).toBe('0.006');
    expect(mulQty('0', '7')).toBe('0');
    expect(subQty(0, mulQty('1.0005', '1'))).toBe('-1.001');
  });
});
