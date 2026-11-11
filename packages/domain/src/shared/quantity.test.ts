// Quantity arithmetic lives in @compass/contracts (no test runner types
// there); the run reducer and the API's demand sums use it (RUNAPI-05).
import { describe, expect, it } from 'bun:test';
import {
  addQty,
  milliQty,
  mulQty,
  normalizeQty,
  qtyMilli,
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
