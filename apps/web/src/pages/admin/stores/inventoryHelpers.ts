/**
 * Pure helpers for Admin → Stores → Inventory (2026-10-21).
 */
import { toQtyInput } from '../../../lib/format';

/**
 * SKUs that can get an opening stocktake: active SKUs of the org with no
 * ledger row at this store yet (those already have a level row and their
 * own Stocktake button). Input order is preserved.
 */
export function skusWithoutLevel<T extends { id: string; isArchived?: boolean }>(
  skus: ReadonlyArray<T>,
  levels: ReadonlyArray<{ skuId: string }>,
): T[] {
  const stocked = new Set(levels.map((l) => l.skuId));
  return skus.filter((sku) => !sku.isArchived && !stocked.has(sku.id));
}

/** Movement reasons the ledger writes (see packages/db schema/inventory.ts). */
export const MOVEMENT_REASONS = [
  'delivery_received',
  'stocktake',
  'wastage',
  'consumption',
  'consumption_reversed',
  'transfer_in',
  'transfer_out',
  'adjustment',
] as const;
export type MovementReason = (typeof MOVEMENT_REASONS)[number];

/** Narrow a raw `movements.reason` to a known one (null → show raw). */
export function knownMovementReason(reason: string): MovementReason | null {
  return (MOVEMENT_REASONS as readonly string[]).includes(reason)
    ? (reason as MovementReason)
    : null;
}

/** "+1.5" / "-0.25" — signed delta for the movements list. */
export function signedDelta(delta: string): { sign: '+' | '-' | ''; abs: string } {
  const n = Number(delta);
  if (!Number.isFinite(n) || n === 0) return { sign: '', abs: '0' };
  return { sign: n > 0 ? '+' : '-', abs: String(Math.abs(n)) };
}

/**
 * CMP-INV-3 (2026-10-31): what a wastage entry still lacks, or null when
 * it can be saved. Save stayed tappable on an empty form and only then
 * said what was wrong; now it is greyed out and this reason is shown.
 */
export function wastageMissing(
  qtyText: string,
  note: string,
  read: (raw: string) => { ok: true; value: string } | { ok: false },
): 'qty' | 'note' | null {
  const qty = read(qtyText);
  if (!qty.ok || qty.value === '' || !(Number(qty.value) > 0)) return 'qty';
  if (!note.trim()) return 'note';
  return null;
}

/**
 * CMP-INV-2 (2026-10-31): has the stocktake / wastage sheet been typed
 * into? Then closing it by Esc, backdrop or back asks first.
 */
export function inventoryDraftChanged(
  action: { kind: 'stocktake'; current: string } | { kind: 'wastage' } | null,
  draft: { target: string; wasteQty: string; note: string },
): boolean {
  if (!action) return false;
  if (draft.note.trim() !== '') return true;
  return action.kind === 'stocktake'
    ? draft.target !== stocktakePrefill(action.current)
    : draft.wasteQty.trim() !== '';
}

/**
 * DX-INV-1 / DX-INV-7 (2026-11-01): what the count field starts with —
 * the system figure as an editable number ('20.000' → '20'), or empty
 * when the system figure is negative: a shelf never holds -0.5 kg, and
 * the prefilled "-0.500" was itself refused by the count check.
 */
export function stocktakePrefill(current: string): string {
  return Number(current) < 0 ? '' : toQtyInput(current);
}

/**
 * DX-INV-3 (2026-11-01): level rows in the order to look at them —
 * negative stock first (the record is off and needs a count), then by
 * name in the interface language. Sorting with no locale ordered Chinese
 * names by code point.
 */
export function sortLevelRows<T extends { name: string; onHandNum: number }>(
  rows: ReadonlyArray<T>,
  locale: string,
): T[] {
  return [...rows].sort(
    (a, b) =>
      Number(b.onHandNum < 0) - Number(a.onHandNum < 0) || a.name.localeCompare(b.name, locale),
  );
}
