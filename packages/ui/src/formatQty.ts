import { QTY_DECIMALS } from './qtyDraft';

const qtyFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  maximumFractionDigits: QTY_DECIMALS,
});

/**
 * A quantity for display: comma thousands, up to 3 decimals (the DB's
 * numeric(12,3)), no trailing zeros: 1200 → "1,200", 0.050 → "0.05". The
 * same in every UI language, as the app's other numbers (en-US, so no
 * locale puts a narrow space in). An empty value gives '', and one that
 * is not a finite number comes back as it was, so a server value can be
 * piped through. Presentation only: never seed an input or a request with
 * it (apps/web's toQtyInput does that).
 *
 * Review UI-35 (2026-11-12): the one formatter of the app and the kit.
 * QtyControl had its own, without thousands, so a line of 1000 read
 * "1000" on its stepper and "1,000" in the order summary and approval.
 */
export function formatQty(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  return qtyFormatter.format(n);
}
