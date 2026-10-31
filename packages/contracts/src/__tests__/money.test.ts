import { describe, expect, it } from 'bun:test';
import {
  addMoney,
  centsToMoney,
  lineAmountNumber,
  lineAmount,
  lineCents,
  lineWithinCap,
  sumMoney,
  toCents,
} from '../money';

describe('D1 money rounding', () => {
  it('rounds each line half-up to cents', () => {
    expect(lineAmount('0.5', '2.01')).toBe('1.01');
    expect(lineAmount('0.5', '4.03')).toBe('2.02');
    expect(lineAmount('0.5', '0.01')).toBe('0.01');
    expect(lineAmount('0.25', '0.01')).toBe('0.00');
    expect(lineAmount('2.25', '92000.50')).toBe('207001.13');
    expect(lineAmount('3', '10500.55')).toBe('31501.65');
    expect(lineAmount('1', '0')).toBe('0.00');
  });

  it('sums lines in integer cents: groups add up to the total', () => {
    const lines = [lineAmount('0.5', '2.01'), lineAmount('0.5', '4.03'), lineAmount('0.5', '0.01')];
    expect(lines).toEqual(['1.01', '2.02', '0.01']);
    expect(sumMoney(lines)).toBe('3.04');
    // 0.1 + 0.2 style float noise never appears.
    expect(sumMoney(['0.10', '0.20'])).toBe('0.30');
    expect(sumMoney(['999999999999.99', '999999999999.99', '0.02'])).toBe('2000000000000.00');
  });

  it('keeps display running totals on whole cents', () => {
    let sum = 0;
    for (const v of ['0.10', '0.20', '1.01', '2.02']) sum = addMoney(sum, v);
    expect(sum).toBe(3.33);
    expect(addMoney(0.1, 0.2)).toBe(0.3);
    expect(addMoney(1, null)).toBe(1);
    expect(lineAmountNumber('0.5', '2.01')).toBe(1.01);
  });

  it('formats cents with exactly two decimals', () => {
    expect(centsToMoney(0n)).toBe('0.00');
    expect(centsToMoney(5n)).toBe('0.05');
    expect(centsToMoney(-5n)).toBe('-0.05');
    expect(centsToMoney(123450n)).toBe('1234.50');
  });

  it('reads decimal strings and numbers into cents', () => {
    expect(toCents('12')).toBe(1200n);
    expect(toCents('1.005')).toBe(101n);
    expect(toCents('.5')).toBe(50n);
    expect(toCents('-1.005')).toBe(-101n);
    expect(toCents(1.005)).toBe(101n);
    expect(toCents(0.1 + 0.2)).toBe(30n);
    expect(() => toCents('1e3')).toThrow();
  });

  it('is exact for the largest allowed line', () => {
    expect(lineCents('999999999', '999999999999.99')).toBe(99999999899999000000001n);
    expect(lineWithinCap('999999999', '999999999999.99')).toBe(false);
    expect(lineWithinCap('1', '999999999999.99')).toBe(true);
    expect(lineWithinCap('1000', '1000000000')).toBe(true);
    expect(lineWithinCap('1000.001', '1000000000')).toBe(false);
  });
});
