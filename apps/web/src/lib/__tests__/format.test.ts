import { describe, expect, it } from 'bun:test';

import { formatMoney, formatMoneyThousands, formatQty, minorUnits, toQtyInput } from '../format';

/**
 * These tests exist because PurchaseRow seeded its qty input with
 * `formatQty`, which is a display helper. The first block pins the
 * damage that caused so nobody "simplifies" the two functions back
 * into one; the second pins the replacement.
 */
describe('formatQty is a DISPLAY helper and must not seed an input', () => {
  it('inserts thousand separators — illegal in <input type="number">', () => {
    expect(formatQty('1200.000')).toBe('1,200');
    expect(Number(formatQty('1200.000'))).toBeNaN();
  });
});

// F1 / RE-CLS-6 (2026-10-30): quantities used to round to one decimal, so
// 0.05 kg of onion read "0.1" and a stocktake started from the wrong figure.
describe('formatQty', () => {
  it('shows up to three decimals, the precision the server stores', () => {
    expect(formatQty('8.949')).toBe('8.949');
    expect(formatQty('0.050')).toBe('0.05');
    expect(formatQty('1.005')).toBe('1.005');
    expect(formatQty('1.250')).toBe('1.25');
    expect(formatQty(-0.05)).toBe('-0.05');
  });

  it('drops trailing zeros and keeps whole numbers whole', () => {
    expect(formatQty('3.000')).toBe('3');
    expect(formatQty('1234567.000')).toBe('1,234,567');
  });

  it('passes empty and non-numeric values through', () => {
    expect(formatQty('')).toBe('');
    expect(formatQty(null)).toBe('');
    expect(formatQty('abc')).toBe('abc');
  });
});

// F1 / HIS-17 / CLS-10 (2026-10-30): money used to round to one decimal —
// 12.35 USD read "12.4 USD", 8,164,371.65 read "8,164,371.7".
describe('formatMoney', () => {
  it('shows every minor unit of the currency', () => {
    expect(formatMoney('12.35', 'USD')).toBe('12.35 USD');
    expect(formatMoney('1234567.89', 'RUB')).toBe('1,234,567.89 RUB');
    expect(formatMoney('8164371.65')).toBe('8,164,371.65');
    expect(formatMoney('12000.56')).toBe('12,000.56');
    expect(formatMoney(-2000.25)).toBe('-2,000.25');
    expect(formatMoney('999999999999.99')).toBe('999,999,999,999.99');
  });

  it('pads a fractional amount to full minor units so prices line up', () => {
    expect(formatMoney('12.3', 'USD')).toBe('12.30 USD');
    expect(formatMoney(0.5)).toBe('0.50');
  });

  it('keeps whole amounts whole', () => {
    expect(formatMoney('1000.00')).toBe('1,000');
    expect(formatMoney(35000, 'UZS')).toBe('35,000 UZS');
    // Float noise from a client-side sum never shows.
    expect(formatMoney(0.1 + 0.2)).toBe('0.30');
    expect(formatMoney(12.004)).toBe('12');
  });

  it('follows the currency: none for JPY, three for KWD', () => {
    expect(formatMoney('1234.5', 'JPY')).toBe('1,235 JPY');
    expect(formatMoney('1.2345', 'KWD')).toBe('1.235 KWD');
    expect(minorUnits('UZS')).toBe(2);
    expect(minorUnits(null)).toBe(2);
    expect(minorUnits('not-a-code')).toBe(2);
  });

  it('bare numbers when no currency is named', () => {
    expect(formatMoney('5', null)).toBe('5');
    expect(formatMoney('5', 'none')).toBe('5');
    expect(formatMoney('')).toBe('');
    expect(formatMoney('x', 'USD')).toBe('x');
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

describe('formatMoneyThousands', () => {
  it('is exact and drops trailing zeros', () => {
    expect(formatMoneyThousands('4500.00')).toBe('4.5K');
    expect(formatMoneyThousands(38000)).toBe('38K');
    expect(formatMoneyThousands('33333.33')).toBe('33.33333K');
    expect(formatMoneyThousands('')).toBe('');
  });
});
