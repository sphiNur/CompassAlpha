/**
 * Review COREAPI-18 (2026-11-09): notifications write amounts with
 * contracts' moneyText, the screen with formatMoney. Both follow the
 * display rule in format.ts's header, or a notification and the screen
 * would show one amount two ways.
 */
import { describe, expect, test } from 'bun:test';
import { moneyText } from '@compass/contracts/money';
import { formatMoney } from '../format';

const SAMPLES: Array<string | number> = [
  '0',
  '0.004',
  '0.005',
  '0.5',
  '12.3',
  '12.35',
  '12.004',
  '1000',
  '1000.00',
  '1000.5',
  '1234567.89',
  '999999999999.99',
  '-0.004',
  '-0.05',
  '-1234.5',
  0.1 + 0.2,
  1234567.5,
];

describe('moneyText (notifications) and formatMoney (screen)', () => {
  test('write every sample the same way', () => {
    expect(SAMPLES.map((v) => [v, moneyText(v)])).toEqual(SAMPLES.map((v) => [v, formatMoney(v)]));
  });

  test('comma thousands; a whole amount without decimals, any other with both cents', () => {
    expect(moneyText('1234567.5')).toBe('1,234,567.50');
    expect(moneyText('1000.00')).toBe('1,000');
    expect(moneyText('-0.05')).toBe('-0.05');
    expect(moneyText(12.3)).toBe('12.30');
  });
});
