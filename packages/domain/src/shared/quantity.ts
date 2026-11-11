/**
 * Quantities in the aggregates (review RUNAPI-05, 2026-11-09).
 *
 * The arithmetic is @compass/contracts' quantity.ts: whole thousandths, no
 * float sums. This adds the reading of quantities already stored in
 * events, which a replay must never fail on. A payload written before
 * 2026-11 can hold float noise ("0.30000000000000004"), which rounds to
 * 3 decimals here; anything that is not a plain decimal goes through
 * Number, as the old code did.
 */
import { qtyMilli } from '@compass/contracts/quantity';

export { milliQty } from '@compass/contracts/quantity';

/** A stored quantity in thousandths; missing or unreadable counts as 0. */
export function storedQtyMilli(value: string | null | undefined): bigint {
  if (value === null || value === undefined || value === '') return 0n;
  try {
    return qtyMilli(value);
  } catch {
    // Not a plain decimal: fall back to Number below.
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return 0n;
  try {
    return qtyMilli(n);
  } catch {
    return 0n;
  }
}
