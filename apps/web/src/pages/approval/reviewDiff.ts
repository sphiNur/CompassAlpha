/**
 * DX-APR-3 (2026-11-01): what changed in an order after the reviewer
 * opened it. A realtime refresh used to swap the lines in silence, so
 * 「通过」 approved a version nobody had looked at. The card keeps the
 * lines as first seen; when the order's seq moves for a reason other
 * than the reviewer's own edits, the changed lines are marked
 * ("10 → 12 kg") until the reviewer says they have seen them.
 */
export interface SeenOrder {
  seq: number;
  /** skuId → total qty, as shown when opened (or last acknowledged). */
  qtyBySku: ReadonlyMap<string, number>;
}

export function snapshotOrder(
  seq: number,
  totals: ReadonlyArray<{ skuId: string; qty: string | number }>,
): SeenOrder {
  const qtyBySku = new Map<string, number>();
  for (const t of totals) {
    const q = Number(t.qty);
    if (q > 0) qtyBySku.set(t.skuId, (qtyBySku.get(t.skuId) ?? 0) + q);
  }
  return { seq, qtyBySku };
}

/** skuId → the quantity first seen (0 = a line that was not there). */
export function changedSinceSeen(seen: SeenOrder | null, now: SeenOrder): Map<string, number> {
  const changed = new Map<string, number>();
  if (!seen || seen.seq === now.seq) return changed;
  const skus = new Set([...seen.qtyBySku.keys(), ...now.qtyBySku.keys()]);
  for (const skuId of skus) {
    const before = seen.qtyBySku.get(skuId) ?? 0;
    const after = now.qtyBySku.get(skuId) ?? 0;
    if (Math.abs(before - after) > 1e-9) changed.set(skuId, before);
  }
  return changed;
}

/**
 * DX-APR-8: lines the reviewer set to 0. They stay on the card, struck
 * through and restorable; a line the staff removed while drafting (set
 * to 0 by its own contributor) is not shown.
 */
export function zeroedInReview<
  T extends { skuId: string; qty: string; contributorMemberId: string; updatedByMemberId?: string | null },
>(items: readonly T[]): T[] {
  const live = new Set(items.filter((i) => Number(i.qty) > 0).map((i) => i.skuId));
  return items.filter(
    (i) =>
      Number(i.qty) === 0 &&
      !live.has(i.skuId) &&
      !!i.updatedByMemberId &&
      i.updatedByMemberId !== i.contributorMemberId,
  );
}

/** DX-APR-8: the server refuses to approve an order with no lines and no other items. */
export function approvable(itemCount: number, extrasCount: number): boolean {
  return itemCount > 0 || extrasCount > 0;
}
