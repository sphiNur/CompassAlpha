import { describe, expect, test } from 'bun:test';
import { lineCentsOf, moneyLine, sumMoneyLines } from '../money';

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

  test('a total adds lines already rounded to cents', () => {
    // As floats: 0.1*3 + 0.2*3 = 0.9000000000000001; in cents 0.90.
    expect(
      sumMoneyLines([
        ['3', '0.1'],
        ['3', '0.2'],
      ]),
    ).toBe(0.9);
    // Each half cent rounds up on its own line: 1.01 + 1.01, not 2.01.
    expect(
      sumMoneyLines([
        ['0.5', '2.01'],
        ['0.5', '2.01'],
      ]),
    ).toBe(2.02);
    // A line without a price adds nothing.
    expect(sumMoneyLines([['2', null], ['1', '5']])).toBe(5);
    expect(sumMoneyLines([])).toBe(0);
  });

  test('numbers are taken as plain decimals', () => {
    expect(moneyLine(0.1, 3)).toBe(0.3);
    expect(moneyLine(100, 2)).toBe(200);
    expect(moneyLine(1e-7, 5)).toBe(0);
  });
});
