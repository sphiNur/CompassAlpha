/**
 * What changed on a run after a store had confirmed receipt — the lines
 * history labels (owner decisions D3 and D4, 2026-10-31):
 *
 *   - `amendAdded`: quantity a correction of the finished run gave a store
 *     beyond what it confirmed. It counts as received (no second receipt),
 *     and history says it was added in a correction ("修改时补记").
 *   - `priceAfterReceipt`: a price changed after a store receiving the
 *     line had confirmed. Allowed — the price is the purchaser's — and it
 *     changes the amount only, never stock; history keeps the trail.
 *
 * Pure: replays the run stream with the aggregate's own reducer.
 */
import { applyRun, emptyRunState, type RunEvent, type RunState } from '@compass/domain/run';

export type RunCorrection =
  | {
      kind: 'amendAdded';
      skuId: string;
      storeId: string;
      /** Quantity beyond what the store confirmed, as a decimal string. */
      qty: string;
    }
  | {
      kind: 'priceAfterReceipt';
      skuId: string;
      /** The one store this price is for, or null for the item price. */
      storeId: string | null;
      at: string;
      from: string | null;
      to: string;
      reason: string;
    };

/** Thousandths, as integers: qty columns are numeric(12,3). */
const milli = (v: string) => Math.round(Number(v) * 1000);

function effectivePrice(state: RunState, skuId: string, storeId: string): string | null {
  const item = state.items.get(skuId);
  if (!item) return null;
  const split = item.storeSplits.find((sp) => sp.storeId === storeId);
  return split?.unitPrice ?? item.unitPrice;
}

/**
 * `visibleStoreIds` null = every store; otherwise lines and prices are
 * limited to those stores (a store-scoped history reader).
 */
export function runCorrections(
  events: readonly RunEvent[],
  visibleStoreIds: ReadonlySet<string> | null,
): RunCorrection[] {
  const visible = (storeId: string) => visibleStoreIds === null || visibleStoreIds.has(storeId);
  let state = emptyRunState(events[0]?.streamId ?? '');
  // store|sku → qty the store had when it confirmed.
  const confirmedQty = new Map<string, number>();
  const confirmedStores = new Set<string>();
  const out: RunCorrection[] = [];

  for (const e of events) {
    if (e.type === 'PurchaseRevised') {
      const before = state.items.get(e.payload.skuId);
      const receivedBy = (before?.storeSplits ?? [])
        .map((sp) => sp.storeId)
        .filter((storeId) => confirmedStores.has(storeId) && visible(storeId));
      const next = applyRun(state, e);
      if (receivedBy.length > 0) {
        if (visibleStoreIds === null) {
          const from = before?.unitPrice ?? null;
          const to = e.payload.unitPrice;
          const splitChanged = receivedBy.some(
            (storeId) =>
              effectivePrice(state, e.payload.skuId, storeId) !==
              effectivePrice(next, e.payload.skuId, storeId),
          );
          if (from !== to || splitChanged) {
            out.push({
              kind: 'priceAfterReceipt',
              skuId: e.payload.skuId,
              storeId: null,
              at: e.occurredAt.toISOString(),
              from,
              to,
              reason: e.payload.reason,
            });
          }
        } else {
          for (const storeId of receivedBy) {
            const from = effectivePrice(state, e.payload.skuId, storeId);
            const to = effectivePrice(next, e.payload.skuId, storeId);
            if (to === null || from === to) continue;
            out.push({
              kind: 'priceAfterReceipt',
              skuId: e.payload.skuId,
              storeId,
              at: e.occurredAt.toISOString(),
              from,
              to,
              reason: e.payload.reason,
            });
          }
        }
      }
      state = next;
      continue;
    }
    state = applyRun(state, e);
    if (e.type === 'StoreConfirmed') {
      const storeId = e.payload.storeId;
      confirmedStores.add(storeId);
      for (const item of state.items.values()) {
        if (item.status !== 'purchased') continue;
        for (const sp of item.storeSplits) {
          if (sp.storeId === storeId) confirmedQty.set(`${storeId}|${item.skuId}`, milli(sp.qty));
        }
      }
    }
  }

  for (const item of state.items.values()) {
    if (item.status !== 'purchased') continue;
    for (const sp of item.storeSplits) {
      if (!confirmedStores.has(sp.storeId) || !visible(sp.storeId)) continue;
      const added = milli(sp.qty) - (confirmedQty.get(`${sp.storeId}|${item.skuId}`) ?? 0);
      if (added <= 0) continue;
      out.push({
        kind: 'amendAdded',
        skuId: item.skuId,
        storeId: sp.storeId,
        qty: String(added / 1000),
      });
    }
  }
  return out;
}
