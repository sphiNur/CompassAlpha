/**
 * Run-stage gating predicates.
 *
 * These decide whether the page-level MainButton renders at all, so a
 * wrong answer does not disable a button — it deletes it, and the
 * purchaser is left with no visible way forward. Extracted here so the
 * rules are testable rather than living inside a useMemo.
 */

export interface SplitLike {
  storeId: string;
  confirmedAt?: string | null;
  deliveredAt?: string | null;
}

export interface ItemStatusLike {
  status: string;
}

/**
 * Every store that received something has confirmed receipt.
 *
 * The zero-split case is the interesting one. A trip where nothing
 * could be bought — market shut, supplier absent, a whole category gone
 * — produces no splits at all, and this used to answer `false`:
 *
 *   involved.size === 0 -> return false
 *
 * The Finish button is gated on `visible:` (not `disabled:`), so that
 * answer removed it from the screen and parked the run in `delivering`
 * with no exit but Cancel — which discards the one fact the trip did
 * establish, that every item was checked and none were available.
 *
 * Zero stores to confirm IS confirmed, and the server has always agreed:
 * FinishRun in packages/domain/src/run/commands.ts builds the same
 * involved-store set and loops over it, so an empty set raises nothing
 * and the command succeeds. The client guard was the only thing that
 * disagreed.
 */
export function allStoresConfirmed(splits: readonly SplitLike[]): boolean {
  const involved = new Set<string>();
  for (const sp of splits) involved.add(sp.storeId);
  if (involved.size === 0) return true;
  for (const id of involved) {
    const confirmed = splits
      .filter((sp) => sp.storeId === id)
      .every((sp) => !!sp.confirmedAt);
    if (!confirmed) return false;
  }
  return true;
}

/**
 * Every item has been either bought or marked unavailable.
 *
 * `items.length > 0` stays: a run with no items at all is a data
 * problem, not a finished trip, and advancing it would create an empty
 * delivery.
 */
export function allItemsHandled(items: readonly ItemStatusLike[]): boolean {
  return (
    items.length > 0 &&
    items.every((i) => i.status === 'purchased' || i.status === 'unavailable')
  );
}
