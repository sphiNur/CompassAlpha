/**
 * Pure helpers for Admin → Stores → Inventory (2026-10-21).
 */

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
