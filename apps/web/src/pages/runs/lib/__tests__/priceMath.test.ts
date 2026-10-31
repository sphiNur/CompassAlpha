/**
 * Pins the thousands-mode price conversion (M3.36). Exact decimal
 * shifting is the load-bearing detail: float drift (147.555 × 1000 =
 * 147555.00000000003) fails the server's price format, and the old
 * `.toFixed(3)` clamp turned 92,000.50 into 92,001 (R2-BUY-3).
 */
import { describe, it, expect } from 'bun:test';
import { toDisplayPrice, fromDisplayPrice, isUnusualPrice, readDisplayPrice } from '../priceMath';

describe('toDisplayPrice', () => {
  it('divides by 1000 in thousands mode', () => {
    expect(toDisplayPrice('147500', true)).toBe('147.5');
    expect(toDisplayPrice('1000', true)).toBe('1');
    expect(toDisplayPrice('1', true)).toBe('0.001');
  });

  it('passes through when not in thousands mode', () => {
    expect(toDisplayPrice('147500', false)).toBe('147500');
  });

  it('passes through empty / NaN so intermediate typing states survive', () => {
    expect(toDisplayPrice('', true)).toBe('');
    expect(toDisplayPrice('abc', true)).toBe('abc');
  });
});

describe('fromDisplayPrice', () => {
  it('multiplies back to raw UZS', () => {
    expect(fromDisplayPrice('147.5', true)).toBe('147500');
  });

  it('is exact: no float drift', () => {
    // 147.555 * 1000 === 147555.00000000003 in raw float math.
    expect(fromDisplayPrice('147.555', true)).toBe('147555');
    expect(fromDisplayPrice('92.0005', true)).toBe('92000.5');
    expect(fromDisplayPrice('.5', true)).toBe('500');
  });

  it('passes through when not in thousands mode / empty / NaN', () => {
    expect(fromDisplayPrice('147.5', false)).toBe('147.5');
    expect(fromDisplayPrice('', true)).toBe('');
    expect(fromDisplayPrice('147.', true)).toBe('147000');
  });

  it('round-trips with toDisplayPrice', () => {
    expect(fromDisplayPrice(toDisplayPrice('147500', true), true)).toBe('147500');
    // R2-BUY-3: a price with cents survives the ×1000 field unchanged.
    for (const raw of ['92000.5', '10500.55', '0.01', '999999999999.99']) {
      expect(fromDisplayPrice(toDisplayPrice(raw, true), true)).toBe(raw);
    }
    expect(toDisplayPrice('92000.50', true)).toBe('92.0005');
    expect(toDisplayPrice('10500.55', true)).toBe('10.50055');
  });
});

describe('readDisplayPrice (R2-BUY-2)', () => {
  it('accepts what the server stores, in either unit', () => {
    expect(readDisplayPrice('92000.55', false)).toBe('92000.55');
    expect(readDisplayPrice('92.00055', true)).toBe('92000.55');
    expect(readDisplayPrice('999999999999.99', false)).toBe('999999999999.99');
  });

  it('refuses a 3rd decimal, a 13th digit, zero and text', () => {
    expect(readDisplayPrice('92000.555', false)).toBeNull();
    expect(readDisplayPrice('92.000555', true)).toBeNull();
    expect(readDisplayPrice('1234567890123', false)).toBeNull();
    expect(readDisplayPrice('1234567890123', true)).toBeNull();
    expect(readDisplayPrice('0', false)).toBeNull();
    expect(readDisplayPrice('1e3', false)).toBeNull();
    expect(readDisplayPrice('', true)).toBeNull();
  });
});

describe('isUnusualPrice', () => {
  it('catches a wrong unit and a slipped zero, in both directions', () => {
    expect(isUnusualPrice('3000000', '30000')).toBe(true);
    expect(isUnusualPrice('30', '30000')).toBe(true);
    expect(isUnusualPrice('3000', '30000')).toBe(true);
    expect(isUnusualPrice('150000', '30000')).toBe(true);
  });

  it('lets an ordinary market move through', () => {
    expect(isUnusualPrice('30000', '30000')).toBe(false);
    expect(isUnusualPrice('45000', '30000')).toBe(false);
    expect(isUnusualPrice('8000', '30000')).toBe(false);
  });

  it('has nothing to say without a last price or a number', () => {
    expect(isUnusualPrice('30000', null)).toBe(false);
    expect(isUnusualPrice('30000', '')).toBe(false);
    expect(isUnusualPrice('', '30000')).toBe(false);
    expect(isUnusualPrice('abc', '30000')).toBe(false);
  });
});
