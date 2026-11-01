import { describe, expect, test } from 'bun:test';
import { moneyProblem } from '../moneyProblem';

describe('moneyProblem (DX-CLS-3 / DX-CLS-4)', () => {
  test('names one reason per bad amount', () => {
    expect(moneyProblem('')).toBe('empty');
    expect(moneyProblem('   ')).toBe('empty');
    expect(moneyProblem('-5')).toBe('negative');
    expect(moneyProblem('-0')).toBe('negative');
    expect(moneyProblem('abc')).toBe('notNumber');
    expect(moneyProblem('1.2.3')).toBe('notNumber');
    expect(moneyProblem('-')).toBe('notNumber');
    expect(moneyProblem('12.345')).toBe('decimals');
    expect(moneyProblem('99999999999999')).toBe('tooLarge');
  });

  test('accepts what the page saves', () => {
    for (const ok of ['0', '0.5', '150000', '320000.50', '999999999999.99']) {
      expect(moneyProblem(ok)).toBeNull();
    }
  });

  test('a signed field takes a negative amount', () => {
    expect(moneyProblem('-5', { signed: true })).toBeNull();
    expect(moneyProblem('-12.345', { signed: true })).toBe('decimals');
  });

  test('an expense or wage line must be above zero', () => {
    expect(moneyProblem('0', { positive: true })).toBe('zero');
    expect(moneyProblem('0.00', { positive: true })).toBe('zero');
    expect(moneyProblem('', { positive: true })).toBe('empty');
    expect(moneyProblem('0.01', { positive: true })).toBeNull();
  });
});
