/**
 * Run-wide numbers for the pre-run preview header.
 *
 * Pulled out of RunPanels as a pure function because this is the only
 * money-shaped figure on that screen and apps/web has no DOM test
 * environment — a wrong denominator here is invisible until someone
 * counts by hand in a market.
 *
 * Two rules that are easy to get wrong and are pinned by the tests:
 *
 *   1. Counts are of DISTINCT ITEMS, not of rows. `byStore` holds one
 *      row per (store, item), so a SKU three shops want is three rows
 *      and one thing to buy. "No stall: 3" meaning a single unassigned
 *      SKU across three shops would be a lie.
 *   2. `knownTotal` is the opposite — it sums ROWS, because each row is
 *      a real quantity being bought for a real store.
 */
import type { PreviewStoreGroup } from '../types';

export type PreviewStats = {
  /** Distinct items in the run (SKUs + off-catalog extras). */
  total: number;
  /** Distinct items with a usable reference price. */
  known: number;
  /** Distinct catalog SKUs with no preferred stall assigned. */
  noSupplier: number;
  /**
   * Sum of every priced row. Systematically LOW: unpriced rows are
   * dropped entirely, and run expenses (transport, porters, market fees)
   * do not exist until the run is finished. Render it as "at least",
   * never as "≈", and never as "cash to bring".
   */
  knownTotal: number;
};

/** Merge key for a line — extras have no skuId, so they key on their
 *  own localized name + unit, the same rule the vendor share-text uses. */
function itemKey(line: PreviewStoreGroup['items'][number]): string {
  return line.skuId ?? `extra:${line.name}|${line.unit}`;
}

export function computePreviewStats(
  byStore: readonly PreviewStoreGroup[],
  /** True when this SKU has a preferred stall link. */
  hasSupplier: (skuId: string) => boolean,
): PreviewStats {
  const seen = new Set<string>();
  const unpriced = new Set<string>();
  const noSupplier = new Set<string>();
  let knownTotal = 0;

  for (const group of byStore) {
    for (const line of group.items) {
      const key = itemKey(line);
      seen.add(key);
      // Extras are counted here on purpose, unlike in the noSupplier
      // branch below — the asymmetry is deliberate, not an oversight
      // (it was raised as one on 2026-07-27).
      //
      // The two counters answer different questions. noSupplier is an
      // exception you can clear right now by linking a stall, and an
      // off-catalog extra has no skuId to link, so including it would
      // pin the chip above zero permanently. unpriced feeds the
      // estimate's honesty: an extra's cost genuinely is not in
      // knownTotal, and the purchaser WILL discover its price at the
      // stall. Hiding it would make "at least X" quietly overconfident,
      // which is the one thing that line must never be.
      if (line.total === null) unpriced.add(key);
      else knownTotal += line.total;
      // Extras carry no skuId, so they can never hold a preferred
      // supplier link. Counting them would pin this above zero forever
      // and turn the exception chip into wallpaper.
      if (line.kind === 'sku' && line.skuId && !hasSupplier(line.skuId)) {
        noSupplier.add(key);
      }
    }
  }

  return {
    total: seen.size,
    known: seen.size - unpriced.size,
    noSupplier: noSupplier.size,
    knownTotal,
  };
}
