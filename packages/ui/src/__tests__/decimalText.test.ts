import { describe, expect, test } from 'bun:test';
import { normalizeDecimalInput, setDecimalLocale } from '../decimalText';

describe('normalizeDecimalInput (R6)', () => {
  test('a decimal comma becomes a point', () => {
    expect(normalizeDecimalInput('1,5')).toBe('1.5');
    expect(normalizeDecimalInput('0,25')).toBe('0.25');
    expect(normalizeDecimalInput('12,5')).toBe('12.5');
  });

  test('space grouping (ru/uz) is dropped, including no-break spaces', () => {
    expect(normalizeDecimalInput('1 234,5')).toBe('1234.5');
    expect(normalizeDecimalInput('125 000')).toBe('125000');
    expect(normalizeDecimalInput('9 800')).toBe('9800');
  });

  test('with both marks, the last one is the decimal mark', () => {
    expect(normalizeDecimalInput('1,234.5')).toBe('1234.5');
    expect(normalizeDecimalInput('12.000,75')).toBe('12000.75');
    expect(normalizeDecimalInput('1.234.567,8')).toBe('1234567.8');
  });

  test('keeps one point, a leading minus, and digits only', () => {
    expect(normalizeDecimalInput('1.2.3')).toBe('1.23');
    expect(normalizeDecimalInput('-2,5')).toBe('-2.5');
    expect(normalizeDecimalInput('2-5')).toBe('25');
    expect(normalizeDecimalInput('12kg')).toBe('12');
    expect(normalizeDecimalInput('')).toBe('');
    expect(normalizeDecimalInput('.')).toBe('.');
  });

  test('plain numbers pass through unchanged', () => {
    for (const v of ['0', '1', '1.5', '125000', '0.001']) expect(normalizeDecimalInput(v)).toBe(v);
  });

  test('RE-CLS-4: zh / en read comma-grouped thousands; ru / uz keep the decimal comma', () => {
    try {
      setDecimalLocale('zh');
      expect(normalizeDecimalInput('1,000')).toBe('1000');
      expect(normalizeDecimalInput('1,500,000')).toBe('1500000');
      expect(normalizeDecimalInput('12,500.5')).toBe('12500.5');
      expect(normalizeDecimalInput('1,5')).toBe('1.5');
      expect(normalizeDecimalInput('1,50')).toBe('1.50');
      setDecimalLocale('en');
      expect(normalizeDecimalInput('2,000')).toBe('2000');
      setDecimalLocale('ru');
      expect(normalizeDecimalInput('1,000')).toBe('1.000');
      setDecimalLocale('uz');
      expect(normalizeDecimalInput('1,500')).toBe('1.500');
    } finally {
      setDecimalLocale(null);
    }
  });
});
