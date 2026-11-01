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
  /** BUY-5: demand that joined after the item was decided ("still need"). */
  topUpQty?: string | null;
}

/** Bought or marked unavailable, with no later demand left to decide. */
function isHandled(i: ItemStatusLike): boolean {
  return (i.status === 'purchased' || i.status === 'unavailable') && !(Number(i.topUpQty ?? 0) > 0);
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
  return items.length > 0 && items.every(isHandled);
}

/**
 * How many items still need a decision (2026-07-30).
 *
 * Companion to `allItemsHandled`, which answers the same question as a
 * boolean and is used to GATE the advance button. The gate alone left the
 * purchasing screen with no bottom CTA and no statement of what the gate
 * even was — 85 unhandled items spread over ~7,000 px of list, and nothing
 * on screen answering "what do I do next?". The comment at the top of this
 * file already names that hazard; this is the number the UI needs to say it
 * out loud.
 *
 * Same predicate as `allItemsHandled`, inverted and counted, so the two can
 * never disagree about what "handled" means.
 */
export function pendingItemCount(items: readonly ItemStatusLike[]): number {
  return items.filter((i) => !isHandled(i)).length;
}

/**
 * R2-BUY-5 (2026-10-31): the item card's "bought · unavailable · left"
 * counts, over the same items and with the same "handled" rule as the
 * bottom bar's `pendingItemCount`, so the two never disagree. An item
 * still waiting on later demand counts as left, not bought.
 */
export function itemProgressCounts(items: readonly ItemStatusLike[]): {
  bought: number;
  na: number;
  pending: number;
} {
  let bought = 0;
  let na = 0;
  for (const i of items) {
    if (!isHandled(i)) continue;
    if (i.status === 'purchased') bought += 1;
    else na += 1;
  }
  return { bought, na, pending: pendingItemCount(items) };
}

/**
 * U7 (2026-10-31): what delivery is still waiting for, so the bottom bar
 * can say it instead of disappearing. `undelivered`: stores not yet
 * handed their goods; `unconfirmed`: stores handed their goods that have
 * not confirmed receipt. Each in first-seen order.
 */
export function deliveryWaiting(splits: readonly SplitLike[]): {
  undelivered: string[];
  unconfirmed: string[];
} {
  const order: string[] = [];
  const byStore = new Map<string, SplitLike[]>();
  for (const sp of splits) {
    if (!byStore.has(sp.storeId)) {
      byStore.set(sp.storeId, []);
      order.push(sp.storeId);
    }
    byStore.get(sp.storeId)!.push(sp);
  }
  const undelivered: string[] = [];
  const unconfirmed: string[] = [];
  for (const storeId of order) {
    const here = byStore.get(storeId)!;
    if (here.every((sp) => !!sp.confirmedAt)) continue;
    if (here.every((sp) => !!sp.deliveredAt)) unconfirmed.push(storeId);
    else undelivered.push(storeId);
  }
  return { undelivered, unconfirmed };
}

/**
 * DX-BUY-5 (2026-11-01): the stores' 「其他物品」 the purchaser has not marked
 * bought or not found. They are not run items, so `pendingItemCount` does
 * not see them; starting delivery warns about them instead.
 */
export function pendingExtrasOf<T extends { name: string; status?: string }>(
  extrasByStore: Readonly<Record<string, readonly T[]>> | undefined,
): T[] {
  return Object.values(extrasByStore ?? {})
    .flat()
    .filter((e) => !e.status || e.status === 'pending');
}
