/**
 * Pins the thousands-mode price conversion (M3.36). The `.toFixed(3)`
 * clamp is the load-bearing detail: without it float drift (147.555 ×
 * 1000 = 147555.00000000003) fails the server's `^\d+(\.\d{1,3})?$`
 * validation and the operator's save silently bounces.
 */
import { describe, it, expect } from 'bun:test';
import { toDisplayPrice, fromDisplayPrice } from '../priceMath';

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

  it('clamps float drift so the server regex accepts the result', () => {
    // 147.555 * 1000 === 147555.00000000003 in raw float math.
    expect(fromDisplayPrice('147.555', true)).toBe('147555');
  });

  it('passes through when not in thousands mode / empty / NaN', () => {
    expect(fromDisplayPrice('147.5', false)).toBe('147.5');
    expect(fromDisplayPrice('', true)).toBe('');
    expect(fromDisplayPrice('147.', true)).toBe('147000');
  });

  it('round-trips with toDisplayPrice', () => {
    expect(fromDisplayPrice(toDisplayPrice('147500', true), true)).toBe('147500');
  });
});
