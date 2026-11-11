/**
 * Pins the thousands-mode price conversion (M3.36). Exact decimal
 * shifting is the load-bearing detail: float drift (147.555 × 1000 =
 * 147555.00000000003) fails the server's price format, and the old
 * `.toFixed(3)` clamp turned 92,000.50 into 92,001 (R2-BUY-3).
 */
import { describe, it, expect } from 'bun:test';
import { readDecimalText } from '@compass/ui';
import {
  toDisplayPrice,
  fromDisplayPrice,
  isUnusualFirstPrice,
  isUnusualPrice,
  readDisplayPrice,
  shownPrice,
  switchPriceUnit,
} from '../priceMath';

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

describe('isUnusualFirstPrice', () => {
  it('asks about a first price of a million or more a unit', () => {
    // 12500 typed in ×1000 mode (walkthrough F8, 2026-11-05).
    expect(isUnusualFirstPrice('12500000')).toBe(true);
    expect(isUnusualFirstPrice('1000000')).toBe(true);
    expect(isUnusualFirstPrice('999999.99')).toBe(false);
    expect(isUnusualFirstPrice('85000')).toBe(false);
    expect(isUnusualFirstPrice('abc')).toBe(false);
  });
});

describe('shownPrice (review RUNWEB2-01, 2026-11-09)', () => {
  // The per-store price field, key by key, the way the pieces pass the
  // text around: useDecimalField reports what it read and keeps showing
  // its own text while the value it gets back is what it reported; the
  // sheet stores raw UZS and hands back shownPrice(raw, typed).
  const type = (keys: string, inThousands = true) => {
    let raw = '';
    let typed: string | undefined;
    let fieldText: string | null = null;
    let reported: string | null = null;
    const shown = () => {
      const external = shownPrice(raw, typed, inThousands);
      return fieldText !== null && external === reported ? fieldText : external;
    };
    for (const key of keys) {
      const text = shown() + key;
      const read = readDecimalText(text);
      const out = read.ok ? read.value : text;
      fieldText = text;
      reported = out;
      typed = out;
      raw = fromDisplayPrice(out, inThousands);
    }
    return { shown: shown(), raw };
  };

  it('keeps the point while a thousands price is typed', () => {
    // Before the fix: 12.5 → 125000, 0.5 → 5000, 12.05 → 1205000.
    expect(type('12.5')).toEqual({ shown: '12.5', raw: '12500' });
    expect(type('0.5')).toEqual({ shown: '0.5', raw: '500' });
    expect(type('12.05')).toEqual({ shown: '12.05', raw: '12050' });
    expect(type('147.5')).toEqual({ shown: '147.5', raw: '147500' });
  });

  it('whole numbers and plain UZS are unchanged', () => {
    expect(type('125')).toEqual({ shown: '125', raw: '125000' });
    expect(type('12500', false)).toEqual({ shown: '12500', raw: '12500' });
  });

  it('a change from outside still shows', () => {
    expect(shownPrice('15000', '12.', true)).toBe('15');
    expect(shownPrice('12000', '12.', true)).toBe('12.');
    expect(shownPrice('12000', undefined, true)).toBe('12');
  });
});

describe('switchPriceUnit (review RUNWEB1-15, 2026-11-11)', () => {
  it('keeps the same raw price across the switch, exactly', () => {
    expect(1.005 * 1000).not.toBe(1005); // the float the row used to print
    expect(switchPriceUnit('1.005', true, false)).toBe('1005');
    expect(switchPriceUnit('1005', false, true)).toBe('1.005');
    expect(switchPriceUnit('147.5', true, false)).toBe('147500');
    expect(switchPriceUnit('92000.5', false, true)).toBe('92.0005');
  });

  it('round-trips every price with up to three decimals in thousands', () => {
    for (let milli = 1; milli <= 200_000; milli += 7) {
      const shown = String(milli / 1000);
      const raw = switchPriceUnit(shown, true, false);
      expect(readDisplayPrice(raw, false)).toBe(raw);
      expect(switchPriceUnit(raw, false, true)).toBe(shown);
    }
  });

  it('leaves text that is not a price yet, and an unchanged unit, as typed', () => {
    expect(switchPriceUnit('', true, false)).toBe('');
    expect(switchPriceUnit('12,', true, false)).toBe('12,');
    expect(switchPriceUnit('1.5', true, true)).toBe('1.5');
    expect(switchPriceUnit('12.', false, true)).toBe('0.012');
  });
});
