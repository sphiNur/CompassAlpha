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
 * Money formatter — same shape as `formatQty`. Kept separate so we can
 * later add currency-symbol affordances (e.g. `${v} UZS`, locale-aware
 * symbol placement) without touching every call site. For now it's
 * just `formatOneDecimal`.
 */
export function formatMoney(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  return formatOneDecimal(n);
}

/** Internal — `Intl.NumberFormat` with min 0 / max 1 fraction digits. */
const oneDecimalFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

function formatOneDecimal(n: number): string {
  return oneDecimalFormatter.format(n);
}
