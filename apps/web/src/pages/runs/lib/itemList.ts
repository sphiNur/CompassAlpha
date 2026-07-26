/**
 * What the in-run item list shows, and in what order.
 *
 * The list is the screen the purchaser lives on for the length of a
 * trip, and until now it had no ordering at all: run.get sorts by
 * `asc(skuId)` — random UUIDs — and the aggregate view rendered
 * `run.items.map(...)` straight through. Production runs reach 87 rows
 * and beyond, so "the stallholder is holding up a bag of tomatoes,
 * which row is that" meant scrolling roughly fifty screens, and "what
 * is still left here" meant re-scanning all 87 at every stall.
 *
 * (A comment in RunViews claimed "the aggregate view sorts by
 * sortIndex". There is no sortIndex on a run item — the field exists
 * only on admin catalogue rows — and there never was a sort.)
 *
 * ## Why the order does not depend on status
 *
 * The obvious ordering is "unfinished first", and the per-stall view
 * already does it. It is a trap on a touch screen: saving the top row
 * moves that row to the bottom bucket and pulls every row below it up
 * by one, under a thumb that is already descending toward the next ✓.
 * The second tap lands on a row that was not there when the finger
 * started moving — and on this list a tap commits money.
 *
 * So position is a function of the item, never of its progress. Rows
 * stay put for the whole trip, completed work is shown in place, and
 * "hide what I have already done" is an explicit filter the purchaser
 * chooses rather than something the list does underneath them.
 */
import { matchesAnyString } from '../../../lib/searchMatch';

/** Which rows the purchaser has asked to see. */
export type ItemFilter = 'all' | 'pending' | 'unavailable';

export interface ItemView<T> {
  /** Localized display name — primary sort key and search field. */
  nameOf: (item: T) => string;
  /** Stall this is bought at, null when unassigned. */
  supplierNameOf?: (item: T) => string | null | undefined;
  /** Anything else worth searching: notes, codes, a second language. */
  extraHaystackOf?: (item: T) => Array<string | null | undefined>;
  statusOf: (item: T) => string;
  /** Stable final tiebreak so equal names never swap between renders. */
  idOf: (item: T) => string;
}

export function matchesFilter(status: string, filter: ItemFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'pending') return status === 'pending';
  return status === 'unavailable';
}

/**
 * Sort by stall, then name, then id.
 *
 * Stall first because a trip is walked stall by stall, so this is the
 * order the purchaser physically moves in. Unassigned stalls sort last
 * rather than under an empty name, where they would interleave with
 * real stalls whose names begin with a space or a digit.
 *
 * `localeCompare` without a locale argument: the catalogue is
 * bilingual per tenant and the display name has already been resolved
 * to the active language by the caller, so the runtime's collation is
 * the right one. It is stable enough for our purposes and the id
 * tiebreak makes the result total regardless.
 */
export function compareItems<T>(a: T, b: T, view: ItemView<T>): number {
  const as = view.supplierNameOf?.(a) ?? null;
  const bs = view.supplierNameOf?.(b) ?? null;
  if (as && !bs) return -1;
  if (!as && bs) return 1;
  if (as && bs) {
    const c = as.localeCompare(bs);
    if (c !== 0) return c;
  }
  const n = view.nameOf(a).localeCompare(view.nameOf(b));
  if (n !== 0) return n;
  return view.idOf(a).localeCompare(view.idOf(b));
}

/**
 * Apply the search box and the filter chips, then order the result.
 *
 * `tokens` comes from lib/searchMatch's normalizeQuery, so a Russian
 * speaker typing "молоко" still finds a SKU whose display name resolved
 * to Chinese, and "tomto" still finds tomatoes — the same matching the
 * pre-run preview already uses.
 */
export function visibleItems<T>(
  items: readonly T[],
  view: ItemView<T>,
  opts: { tokens?: readonly string[]; filter?: ItemFilter } = {},
): T[] {
  const tokens = opts.tokens ?? [];
  const filter = opts.filter ?? 'all';
  const out = items.filter((it) => {
    if (!matchesFilter(view.statusOf(it), filter)) return false;
    if (tokens.length === 0) return true;
    return matchesAnyString(
      [
        view.nameOf(it),
        view.supplierNameOf?.(it) ?? null,
        ...(view.extraHaystackOf?.(it) ?? []),
      ],
      [...tokens],
    );
  });
  return out.sort((a, b) => compareItems(a, b, view));
}

/** Per-status tallies for the filter chips, computed before filtering. */
export function countByStatus<T>(
  items: readonly T[],
  statusOf: (item: T) => string,
): { all: number; pending: number; purchased: number; unavailable: number } {
  let pending = 0;
  let purchased = 0;
  let unavailable = 0;
  for (const it of items) {
    const s = statusOf(it);
    if (s === 'pending') pending += 1;
    else if (s === 'purchased') purchased += 1;
    else if (s === 'unavailable') unavailable += 1;
  }
  return { all: items.length, pending, purchased, unavailable };
}
