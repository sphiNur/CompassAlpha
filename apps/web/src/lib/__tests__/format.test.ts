import { describe, expect, it } from 'bun:test';

import { formatQty, toQtyInput } from '../format';

/**
 * These tests exist because PurchaseRow seeded its qty input with
 * `formatQty`, which is a display helper. The first block pins the
 * damage that caused so nobody "simplifies" the two functions back
 * into one; the second pins the replacement.
 */
describe('formatQty is a DISPLAY helper and must not seed an input', () => {
  it('rounds to one decimal — silently changes the value', () => {
    expect(formatQty('1.250')).toBe('1.3');
    expect(formatQty('0.667')).toBe('0.7');
  });

  it('inserts thousand separators — illegal in <input type="number">', () => {
    expect(formatQty('1200.000')).toBe('1,200');
    expect(Number(formatQty('1200.000'))).toBeNaN();
  });
});

describe('toQtyInput', () => {
  it('keeps every significant digit — no rounding', () => {
    expect(toQtyInput('1.250')).toBe('1.25');
    expect(toQtyInput('0.667')).toBe('0.667');
    expect(toQtyInput('0.001')).toBe('0.001');
    expect(toQtyInput('1.005')).toBe('1.005');
  });

  it('emits nothing a number input rejects', () => {
    for (const raw of ['1200.000', '999999999.999', '1.250', '0.500', '42']) {
      const out = toQtyInput(raw);
      expect(out).not.toContain(',');
      expect(Number.isFinite(Number(out))).toBe(true);
    }
  });

  it('round-trips the value the API sent', () => {
    for (const raw of ['1.250', '1200.000', '0.667', '3.000', '0.001']) {
      expect(Number(toQtyInput(raw))).toBe(Number(raw));
    }
  });

  it('strips only padding zeros, never significant ones', () => {
    expect(toQtyInput('1.000')).toBe('1');
    expect(toQtyInput('10.100')).toBe('10.1');
    // 100 has trailing zeros BEFORE the decimal point — they are
    // significant and the integer branch must not touch them.
    expect(toQtyInput('100')).toBe('100');
    expect(toQtyInput('100.000')).toBe('100');
    expect(toQtyInput('1000')).toBe('1000');
  });

  it('passes non-numeric input through instead of emitting NaN', () => {
    expect(toQtyInput('')).toBe('');
    expect(toQtyInput(null)).toBe('');
    expect(toQtyInput(undefined)).toBe('');
    expect(toQtyInput('abc')).toBe('abc');
  });

  it('accepts numbers as well as server decimal strings', () => {
    expect(toQtyInput(1.25)).toBe('1.25');
    expect(toQtyInput(1200)).toBe('1200');
  });
});
