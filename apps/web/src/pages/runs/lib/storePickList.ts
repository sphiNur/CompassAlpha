/**
 * Per-store pick list for the delivering phase (2026-10-21 FE-03 / F3-01).
 *
 * Once a run reaches `delivering` the per-store view and the item list are
 * hidden, so the purchaser loading the car could not see what goes to
 * which store. This builds that list from the run's ACTUAL splits (what
 * was bought and allocated), not from the ordered demand, so it matches
 * what the store will be asked to confirm.
 *
 * Unavailable SKUs have no split; they are listed separately from the
 * store's demand so the purchaser can see the store asked for them and
 * that they are deliberately not on the truck.
 */
import { addMoney } from '@compass/contracts';
import { splitSubtotal, splitUnitPrice } from './settlement';

export type PickLine = { skuId: string; qty: string; lineTotal: number | null };

export type StorePickList = {
  /** Purchased lines allocated to this store, qty > 0. */
  lines: PickLine[];
  /** SKUs this store ordered that were marked unavailable. */
  unavailable: Array<{ skuId: string; qty: string }>;
  /** Sum of line totals; null when any line has no price. */
  total: number | null;
};

export function buildStorePickList(input: {
  storeId: string;
  items: ReadonlyArray<{ skuId: string; status: string; unitPrice?: string | null }>;
  splits: ReadonlyArray<{
    skuId: string;
    storeId: string;
    qty: string;
    unitPrice?: string | null;
  }>;
  demand?: ReadonlyArray<{ skuId: string; storeId: string; qty: string }> | null;
}): StorePickList {
  const itemBySku = new Map(input.items.map((it) => [it.skuId, it]));
  const lines: PickLine[] = [];
  const onTruck = new Set<string>();
  let total: number | null = 0;
  for (const sp of input.splits) {
    if (sp.storeId !== input.storeId || !(Number(sp.qty) > 0)) continue;
    const item = itemBySku.get(sp.skuId);
    if (item?.status === 'unavailable') continue;
    onTruck.add(sp.skuId);
    const priced = item ? splitUnitPrice(sp, item) : (sp.unitPrice ?? null);
    const lineTotal = priced ? splitSubtotal(sp, item ?? {}) : null;
    if (lineTotal === null) total = null;
    else if (total !== null) total = addMoney(total, lineTotal);
    lines.push({ skuId: sp.skuId, qty: sp.qty, lineTotal });
  }
  const unavailable: Array<{ skuId: string; qty: string }> = [];
  for (const d of input.demand ?? []) {
    if (d.storeId !== input.storeId || onTruck.has(d.skuId)) continue;
    if (itemBySku.get(d.skuId)?.status !== 'unavailable') continue;
    unavailable.push({ skuId: d.skuId, qty: d.qty });
  }
  return { lines, unavailable, total };
}
