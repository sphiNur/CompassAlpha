/**
 * What a purchase row is handed of the run (review RUNWEB1-07).
 *
 * PurchaseRow is memo()'d, and memo() draws a row again for any prop that
 * is a new object, equal or not. The lists rebuilt each row's splits on
 * every render, and handed a fresh `[]` to a SKU without demand, so every
 * row drew again whenever its list did.
 */
import type { ActiveRun } from '../types';

/** A recorded split as the row shows it. */
export interface RowSplit {
  storeId: string;
  qty: string;
  unitPrice?: string | null;
  paymentMethod?: string | null;
}

/** The demand of a SKU that has none: one array, never a new one. */
export const NO_DEMAND: Array<{ storeId: string; qty: string }> = [];
const NO_SPLITS: RowSplit[] = [];

const bySplits = new WeakMap<ActiveRun['splits'], Map<string, RowSplit[]>>();

/**
 * The SKU's recorded splits. Grouped once per `run.splits` array (indexed,
 * not filtered per row: an 87-item run has ~260 splits), so each SKU gets
 * the same array until the run changes.
 */
export function rowSplitsOf(splits: ActiveRun['splits'], skuId: string): RowSplit[] {
  let bySku = bySplits.get(splits);
  if (!bySku) {
    bySku = new Map();
    for (const sp of splits) {
      const row: RowSplit = {
        storeId: sp.storeId,
        qty: sp.qty,
        unitPrice: sp.unitPrice,
        paymentMethod: sp.paymentMethod,
      };
      const list = bySku.get(sp.skuId);
      if (list) list.push(row);
      else bySku.set(sp.skuId, [row]);
    }
    bySplits.set(splits, bySku);
  }
  return bySku.get(skuId) ?? NO_SPLITS;
}
