import { describe, expect, test } from 'bun:test';
import { lineCentsOf, moneyLine } from '../money';

describe('web money helpers (DX-PFE-12, D1)', () => {
  test('a line is qty × price rounded half-up to cents', () => {
    expect(moneyLine('0.5', '2.01')).toBe(1.01); // 1.005 → 1.01
    expect(moneyLine('3', '0.1')).toBe(0.3); // not 0.30000000000000004
    expect(moneyLine(12.4, '98000')).toBe(1215200);
    expect(lineCentsOf('1.005', '1')).toBe(101n);
  });

  test('missing or non-numeric input gives null, not NaN', () => {
    expect(moneyLine('2', null)).toBeNull();
    expect(moneyLine(undefined, '5')).toBeNull();
    expect(moneyLine('', '5')).toBeNull();
    expect(moneyLine('abc', '5')).toBeNull();
    expect(moneyLine(Number.NaN, '5')).toBeNull();
  });

  test('numbers are taken as plain decimals', () => {
    expect(moneyLine(0.1, 3)).toBe(0.3);
    expect(moneyLine(100, 2)).toBe(200);
    expect(moneyLine(1e-7, 5)).toBe(0);
  });
});
