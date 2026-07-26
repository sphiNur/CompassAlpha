/**
 * Display formatters for numbers shown in the UI.
 *
 * User rule (2026-05-04):
 *   "钱数量金额需要用 xxx,xxx,xxx 这种格式,小数点否保留一位就可以"
 *
 * In other words: thousand-separator commas for everything, AT MOST one
 * decimal place. Trailing `.0` is stripped so the common case (whole
 * numbers) reads cleanly:
 *
 *   1000      → "1,000"
 *   1500.5    → "1,500.5"
 *   1500.55   → "1,500.6"   (rounds to 1 decimal)
 *   1234567   → "1,234,567"
 *
 * Server still stores full decimal(12,3) for qty and decimal(14,2) for
 * money. These are PRESENTATION helpers only — never round-tripped back
 * to the API.
 *
 * Locale: forced to 'en-US' so the separators are commas regardless of
 * the user's browser locale. The app is bilingual (zh / en) but the
 * numeric format is the same in both — switching to native locales for
 * Chinese (which would use Western thousands too) is a no-op, while
 * forcing en-US prevents some locales from inserting non-breaking
 * spaces (`fr-FR` → "1 234 567") which would mis-align with our font.
 */

/**
 * Round-half-up to 1 decimal max, drop trailing `.0`, comma-thousands.
 * Returns the original string when the input isn't a finite number,
 * which lets us pipe possibly-empty server values through without
 * breaking.
 */
export function formatQty(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  return formatOneDecimal(n);
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
 * Money formatter — same shape as `formatQty`. Returns the numeric
 * value formatted with `Intl.NumberFormat` (thousand separators, max
 * one decimal). M1.17: accepts an optional `currency` so callers
 * fetched-from-session can suffix the right ISO code. Default 'UZS'
 * preserves the launch tenant's behavior for every existing call
 * site. Pass `currency=null` (or `'none'`) for bare numbers (e.g.
 * inside a label that already says "UZS" in the i18n string).
 */
export function formatMoney(
  v: string | number | null | undefined,
  currency: string | null = null,
): string {
  if (v === null || v === undefined || v === '') return '';
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  const formatted = formatOneDecimal(n);
  if (!currency || currency === 'none') return formatted;
  return `${formatted} ${currency}`;
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

/** Internal — `Intl.NumberFormat` with min 0 / max 1 fraction digits. */
const oneDecimalFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

function formatOneDecimal(n: number): string {
  return oneDecimalFormatter.format(n);
}
