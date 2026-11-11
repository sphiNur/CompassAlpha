/**
 * Thousands-mode price display math (M3.36, 2026-05-19).
 *
 * UZS prices typically run 20–150k; typing the trailing "000" on every
 * row was the operator's #1 friction complaint mid-purchase. In
 * thousands mode the stored / network-sent value stays raw UZS and only
 * the visible string is divided/multiplied at the input boundary.
 *
 * Extracted verbatim from RunPage.tsx (Phase 4 step 1 of the 2026-07
 * frontend audit's run-domain split). Pure functions; unit
 * tests in __tests__/priceMath.test.ts.
 */
import { isPurchasePrice } from '@compass/contracts/limits';

/**
 * Move the decimal point of a plain decimal string by `places` (positive =
 * multiply by 10^places), exactly — no float. Null when `value` is not a
 * plain decimal ("147.", ".5" are; "abc", "1e3" are not).
 *
 * R2-BUY-3 (2026-10-31): the conversion used to go through a float and
 * `.toFixed(3)`, so a 92,000.50 price prefilled the ×1000 field as
 * "92.001" and previewed as 92,001 — a figure nobody entered.
 */
function shiftDecimal(value: string, places: number): string | null {
  const match = /^(\d*)(?:\.(\d*))?$/.exec(value);
  if (!match || (match[1] === '' && !match[2])) return null;
  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  let digits = whole + fraction;
  let point = whole.length + places;
  if (point < 0) {
    digits = '0'.repeat(-point) + digits;
    point = 0;
  }
  if (point > digits.length) digits = digits.padEnd(point, '0');
  const intPart = digits.slice(0, point).replace(/^0+(?=\d)/, '') || '0';
  const fracPart = digits.slice(point).replace(/0+$/, '');
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

/**
 * Convert a raw UZS price string to its thousands-mode display form.
 * "147500" → "147.5", "92000.5" → "92.0005" when in thousands mode;
 * pass-through otherwise. Exact (see shiftDecimal). Returns the input
 * unchanged on empty / not-a-number so intermediate typing states
 * survive.
 */
export function toDisplayPrice(rawStr: string, inThousands: boolean): string {
  if (!inThousands || !rawStr) return rawStr;
  return shiftDecimal(rawStr.trim(), -3) ?? rawStr;
}

/**
 * What a price field shows: the text being typed while it still means
 * the stored price, else the stored price in the current unit.
 *
 * Review RUNWEB2-01 (2026-11-09): the per-store price field read its
 * value back from the stored raw UZS on every keystroke, so in
 * thousands mode "12." (on the way to 12.5) came back as "12", the
 * point was lost, and 12.5 was stored as 125,000. Keeping the typed
 * text while it round-trips to the same raw value fixes that; a change
 * from outside (the main price, the unit switch) still shows through.
 */
export function shownPrice(raw: string, typed: string | undefined, inThousands: boolean): string {
  if (typed !== undefined && fromDisplayPrice(typed, inThousands) === raw) return typed;
  return toDisplayPrice(raw, inThousands);
}

/** Inverse of toDisplayPrice — used when committing back to the
 *  domain (purchaseItem / revisePurchase always speak raw UZS). Exact,
 *  so "147.555" is 147555 and "92.0005" is 92000.5. */
export function fromDisplayPrice(displayStr: string, inThousands: boolean): string {
  if (!inThousands || !displayStr) return displayStr;
  return shiftDecimal(displayStr.trim(), 3) ?? displayStr;
}

/**
 * What a price field shows once the unit switch flips: the same raw price
 * in the other unit. Text that is not a plain decimal yet ("", "12,") stays
 * as typed.
 *
 * Review RUNWEB1-15 (2026-11-11): a purchase row did this as `n / 1000`
 * and `n * 1000` on a float, so about 1.5% of the prices with three
 * decimals in thousands came back with noise ("1.005" → "1004.9999999999999"),
 * which the field then refused as a price. The purchase sheet converted
 * exactly; both now do.
 */
export function switchPriceUnit(
  shown: string,
  wasInThousands: boolean,
  inThousands: boolean,
): string {
  if (wasInThousands === inThousands) return shown;
  return toDisplayPrice(fromDisplayPrice(shown, wasInThousands), inThousands);
}

/**
 * R2-BUY-2 (2026-10-31): the raw price a typed figure stands for, or
 * null while it is not one the server stores (above 0, at most 12
 * digits and 2 decimals — PurchasePriceSchema). A 3rd decimal or a 13th
 * digit used to pass the field, even the 5× check, and only then come
 * back refused by the server.
 */
export function isStorablePrice(raw: string | null | undefined): boolean {
  return raw != null && isPurchasePrice(raw.trim());
}

/** The raw price a typed figure stands for, or null (see isStorablePrice). */
export function readDisplayPrice(displayStr: string, inThousands: boolean): string | null {
  const raw = fromDisplayPrice(displayStr.trim(), inThousands);
  return isStorablePrice(raw) ? raw : null;
}

/**
 * Is this price far enough from the last one paid to be worth a second
 * look? A wrong unit is a factor of 1000 and a slipped zero a factor
 * of 10; real market prices do not move like that between two trips.
 * Measured on production (2026-10-11): 29 of 9,900 consecutive
 * purchases of the same product differed by 5× or more, and nearly all
 * of those were typing mistakes.
 */
export function isUnusualPrice(next: string | number, last: string | number | null | undefined): boolean {
  const n = Number(next);
  const l = Number(last);
  if (last == null || last === '' || !Number.isFinite(n) || !Number.isFinite(l) || n <= 0 || l <= 0) {
    return false;
  }
  return n >= l * 5 || n * 5 <= l;
}

/**
 * Walkthrough F8 (2026-11-05): with no earlier price to compare with,
 * `isUnusualPrice` said nothing, so 12500 typed in ×1000 mode was stored
 * as 12,500,000 a unit without a word. A first price of a million or more
 * a unit is asked about once (UZS market goods run 20–150k a unit; a
 * figure this size is nearly always the ×1000 field read as plain sum).
 */
export const FIRST_PRICE_CHECK_FROM = 1_000_000;

export function isUnusualFirstPrice(next: string | number): boolean {
  const n = Number(next);
  return Number.isFinite(n) && n >= FIRST_PRICE_CHECK_FROM;
}
