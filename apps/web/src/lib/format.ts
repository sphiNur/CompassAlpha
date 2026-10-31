/**
 * Display formatters for numbers shown in the UI.
 *
 * User rule (2026-05-04):
 *   "钱数量金额需要用 xxx,xxx,xxx 这种格式,小数点否保留一位就可以"
 *
 * Thousand-separator commas for everything, and whole numbers read
 * cleanly (no `.0`). The "one decimal" half of that rule was dropped on
 * 2026-10-30 (F1 / HIS-17 / CLS-10 / RE-CLS-6): it made the screen
 * disagree with the database. 12.35 USD showed as 12.4, a day total of
 * 8,164,371.65 as 8,164,371.7, and 0.05 kg of onion taken by one dish
 * as 0.1 — so a stocktake started from the wrong "system" figure.
 *
 *   money: the currency's minor units (2 for UZS/USD/RUB, 0 for JPY;
 *          2 when the currency is not named — the DB stores 2 dp).
 *          A whole amount stays whole, a fractional one shows every
 *          minor digit so a column of prices lines up:
 *            1000 → "1,000"   12.35 → "12.35"   12.3 → "12.30"
 *   qty:   up to 3 decimals (the DB's decimal(12,3)), trailing zeros
 *          dropped:  8.949 → "8.949"   0.050 → "0.05"   1200.000 → "1,200"
 *
 * Server still stores decimal(12,3) for qty and decimal(14,2) for money.
 * These are PRESENTATION helpers only — never round-tripped back to the
 * API (see `toQtyInput`).
 *
 * Locale: forced to 'en-US' so the separators are commas regardless of
 * the user's browser locale. The app is multilingual but the numeric
 * format is the same in every language — forcing en-US prevents some
 * locales from inserting non-breaking spaces (`fr-FR` → "1 234 567")
 * which would mis-align with our font.
 */

/** Quantities: at most 3 decimals (DB precision), trailing zeros dropped. */
export const QTY_MAX_DECIMALS = 3;

/**
 * Comma-thousands, up to 3 decimals, no trailing zeros.
 * Returns the original string when the input isn't a finite number,
 * which lets us pipe possibly-empty server values through without
 * breaking.
 */
export function formatQty(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  return qtyFormatter.format(n);
}

/**
 * Server decimal → a string safe to put in `<input type="number">`.
 *
 * The counterpart to `formatQty`, and the reason it exists: `formatQty`
 * is a PRESENTATION helper (see the file header — "never round-tripped
 * back to the API") and using it to seed an editable field corrupts the
 * value two different ways.
 *
 * It shipped that way in PurchaseRow and cost us both:
 *
 *   formatQty('1.250')    → '1.3'    the row then SAVES 1.3 kg. A plan
 *                                     of 0.5 + 0.75 across two stores is
 *                                     an ordinary aggregate, and
 *                                     computeProportionalSplits emits
 *                                     .toFixed(3) values, so this is the
 *                                     normal case, not an edge one. The
 *                                     screen and the database agree and
 *                                     are both 4% wrong — nothing to
 *                                     notice later.
 *   formatQty('1200.000') → '1,200'  a comma is not valid in a number
 *                                     input, so the field renders EMPTY,
 *                                     Number('1,200') is NaN, canSave is
 *                                     false forever, and the row cannot
 *                                     be recorded at all. Eggs, sacks,
 *                                     anything sold by the gram.
 *
 * So: no rounding, no separators. Strips only the scale zeros Postgres
 * pads decimal(12,3) with ('1.250' → '1.25'), textually, so the value
 * never passes through a float on its way to the field.
 */
export function toQtyInput(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v).trim();
  if (/^-?\d+\.\d+$/.test(s)) {
    // '1.250' → '1.25'; '1.000' → '1'; '0.001' stays '0.001'.
    return s.replace(/0+$/, '').replace(/\.$/, '');
  }
  if (/^-?\d+$/.test(s)) return s;
  // Anything else (already-normalized numbers, exotic input): fall back
  // to the numeric form, and hand back the original when it isn't a
  // number at all rather than silently emitting 'NaN'.
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : s;
}

/**
 * Money formatter. Comma-thousands; a whole amount has no decimals, any
 * other amount shows the currency's minor units in full (see the file
 * header). M1.17: accepts an optional `currency` so callers
 * fetched-from-session can suffix the right ISO code. Pass
 * `currency=null` (or `'none'`) for bare numbers (e.g. inside a label
 * that already says "UZS" in the i18n string) — those use 2 decimals,
 * the precision the server stores money at.
 */
export function formatMoney(
  v: string | number | null | undefined,
  currency: string | null = null,
): string {
  if (v === null || v === undefined || v === '') return '';
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  const code = !currency || currency === 'none' ? null : currency;
  const digits = minorUnits(code);
  // Intl rounds (decimal-correctly, unlike toFixed); a result whose
  // minor digits are all zero is shown whole: 12.004 is "12", not
  // "12.00", and float noise from client-side sums never shows.
  let formatted = moneyFormatter(digits).format(n);
  if (digits > 0 && formatted.endsWith('.' + '0'.repeat(digits))) {
    formatted = formatted.slice(0, -(digits + 1));
    if (formatted === '-0') formatted = '0';
  }
  return code ? `${formatted} ${code}` : formatted;
}

/**
 * A price in thousands, the purchase page's compact unit ("4.5K" for
 * 4,500), trailing zeros dropped so the common whole-thousand price
 * stays short.
 *
 * R2-BUY-3 (2026-10-31): only while the thousands figure needs at most
 * two decimals. A price with cents read "92.0005K" — five decimals,
 * against the rule that amounts show two; such a price is shown in full
 * instead ("92,000.50"), exactly as everywhere else.
 */
export function formatMoneyThousands(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (Math.round(n * 100) % 1000 !== 0) return formatMoney(n);
  return `${thousandsFormatter.format(n / 1000)}K`;
}

/**
 * M1.17: helper for components that need to suffix the right currency
 * code in places where the i18n string doesn't already include it.
 * Reads the active session via the auth store on the call site.
 * Returns 'UZS' if the session hasn't loaded yet (FE-only assumption).
 */
export function currencyOf(
  session: { member?: { currency?: string } } | null | undefined,
): string {
  return session?.member?.currency ?? 'UZS';
}

/** Money's stored precision, used when no currency is named. */
const DEFAULT_MONEY_DECIMALS = 2;

const thousandsFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  maximumFractionDigits: DEFAULT_MONEY_DECIMALS,
});

const qtyFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  maximumFractionDigits: QTY_MAX_DECIMALS,
});

const minorUnitsCache = new Map<string, number>();

/** ISO 4217 minor units of `currency` (UZS 2, JPY 0, KWD 3). */
export function minorUnits(currency: string | null): number {
  if (!currency) return DEFAULT_MONEY_DECIMALS;
  let digits = minorUnitsCache.get(currency);
  if (digits === undefined) {
    try {
      digits = new Intl.NumberFormat('en-US', { style: 'currency', currency })
        .resolvedOptions().maximumFractionDigits;
    } catch {
      // Not an ISO code Intl knows: fall back to the stored precision.
      digits = DEFAULT_MONEY_DECIMALS;
    }
    minorUnitsCache.set(currency, digits ?? DEFAULT_MONEY_DECIMALS);
  }
  return digits ?? DEFAULT_MONEY_DECIMALS;
}

const moneyFormatters = new Map<number, Intl.NumberFormat>();

function moneyFormatter(digits: number): Intl.NumberFormat {
  let f = moneyFormatters.get(digits);
  if (!f) {
    f = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    moneyFormatters.set(digits, f);
  }
  return f;
}
