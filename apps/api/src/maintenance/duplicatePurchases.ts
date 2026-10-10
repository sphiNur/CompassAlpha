/**
 * Finding what re-recorded purchases left behind.
 *
 * Until `PurchaseItem` refused an item that was already bought, a second
 * `ItemPurchased` for the same SKU could land on a run. The aggregate
 * replaced the item's store splits; the projection only upserted them.
 * So a buy first split across stores A and B and then re-recorded for A
 * alone kept B's row in `read_model.run_item_stores_v`. That row counts
 * toward run totals, and if store B went on to confirm the delivery it
 * also became a `delivery_received` stock movement for goods B never got.
 *
 * Everything here is pure: it takes a run's events and the rows that
 * exist for it, and says which rows the event history does not support.
 * Not every repeated `ItemPurchased` is a fault — buy, undo, buy again is
 * a legitimate history — so the events are folded through the aggregate
 * rather than counted.
 */
import { applyRun, emptyRunState, type RunEvent } from '@compass/domain/run';

export interface SplitRow {
  skuId: string;
  storeId: string;
  qty: string;
}

export interface MovementRow {
  id: string;
  skuId: string;
  storeId: string;
  delta: string;
}

export interface RerecordedPurchase {
  skuId: string;
  /** seq of the ItemPurchased that landed on an already-bought item. */
  seq: number;
  occurredAt: Date;
  /** Stores the earlier record named and this one dropped. */
  droppedStoreIds: string[];
}

export interface RunFindings {
  runId: string;
  status: string;
  rerecorded: RerecordedPurchase[];
  /** Split rows for a (sku, store) the aggregate does not have. */
  staleSplits: SplitRow[];
  /** Split rows whose quantity differs from the aggregate's. */
  wrongQtySplits: Array<SplitRow & { expectedQty: string }>;
  /** Aggregate splits with no row at all. */
  missingSplits: SplitRow[];
  /** Stock received by a store for a SKU the run never sent it. */
  phantomMovements: MovementRow[];
}

const sameQty = (a: string, b: string): boolean => Number(a) === Number(b);

export function analyseRun(
  runId: string,
  events: RunEvent[],
  splitRows: SplitRow[],
  movementRows: MovementRow[],
): RunFindings {
  let state = emptyRunState(runId);
  const rerecorded: RerecordedPurchase[] = [];
  for (const event of events) {
    if (event.type === 'ItemPurchased') {
      const before = state.items.get(event.payload.skuId);
      if (before?.status === 'purchased') {
        const kept = new Set(event.payload.storeSplits.map((sp) => sp.storeId));
        rerecorded.push({
          skuId: event.payload.skuId,
          seq: event.seq,
          occurredAt: event.occurredAt,
          droppedStoreIds: before.storeSplits
            .map((sp) => sp.storeId)
            .filter((storeId) => !kept.has(storeId)),
        });
      }
    }
    state = applyRun(state, event);
  }

  // What the history says each store should hold.
  const expected = new Map<string, string>();
  for (const item of state.items.values()) {
    if (item.status !== 'purchased') continue;
    for (const split of item.storeSplits) {
      expected.set(`${item.skuId}|${split.storeId}`, split.qty);
    }
  }

  const staleSplits: SplitRow[] = [];
  const wrongQtySplits: RunFindings['wrongQtySplits'] = [];
  const seen = new Set<string>();
  for (const row of splitRows) {
    const key = `${row.skuId}|${row.storeId}`;
    seen.add(key);
    const expectedQty = expected.get(key);
    if (expectedQty === undefined) staleSplits.push(row);
    else if (!sameQty(expectedQty, row.qty)) wrongQtySplits.push({ ...row, expectedQty });
  }
  const missingSplits: SplitRow[] = [];
  for (const [key, qty] of expected) {
    if (seen.has(key)) continue;
    const [skuId, storeId] = key.split('|') as [string, string];
    missingSplits.push({ skuId, storeId, qty });
  }

  return {
    runId,
    status: state.status,
    rerecorded,
    staleSplits,
    wrongQtySplits,
    missingSplits,
    phantomMovements: movementRows.filter((m) => !expected.has(`${m.skuId}|${m.storeId}`)),
  };
}

export function hasDamage(f: RunFindings): boolean {
  return (
    f.staleSplits.length > 0 ||
    f.wrongQtySplits.length > 0 ||
    f.missingSplits.length > 0 ||
    f.phantomMovements.length > 0
  );
}
