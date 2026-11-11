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
import { milliQty, qtyMilliOrZero } from '@compass/contracts/quantity';
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

function effectivePrice(state: RunState, skuId: string, storeId: string): string | null {
  const item = state.items.get(skuId);
  if (!item) return null;
  const split = item.storeSplits.find((sp) => sp.storeId === storeId);
  return split?.unitPrice ?? item.unitPrice;
}

/** The store's own price on the line, or null when it pays the item price. */
function ownPrice(state: RunState, skuId: string, storeId: string): string | null {
  const split = state.items.get(skuId)?.storeSplits.find((sp) => sp.storeId === storeId);
  return split?.unitPrice ?? null;
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
  // Thousandths (qty columns are numeric(12,3)), read as every quantity is.
  const confirmedQty = new Map<string, bigint>();
  const confirmedStores = new Set<string>();
  const out: RunCorrection[] = [];

  for (const e of events) {
    if (e.type === 'PurchaseRevised') {
      const before = state.items.get(e.payload.skuId);
      const receivedBy = (before?.storeSplits ?? [])
        .map((sp) => sp.storeId)
        .filter((storeId) => confirmedStores.has(storeId) && visible(storeId));
      const next = applyRun(state, e);
      // Review RUNAPI-26: judged by what each receiving store pays, for
      // every reader. A store-scoped reader gets a line per store. For the
      // organisation, the stores that pay the item price share one line
      // for the item (storeId null, as before) and a store with its own
      // price gets its own. The organisation's line used to compare the
      // item price only: a change no receiving store pays was logged, and
      // a change to one store's price read "1000 → 1000".
      const skuId = e.payload.skuId;
      const at = e.occurredAt.toISOString();
      const reason = e.payload.reason;
      let itemLine = false;
      const storeLines: RunCorrection[] = [];
      for (const storeId of receivedBy) {
        const from = effectivePrice(state, skuId, storeId);
        const to = effectivePrice(next, skuId, storeId);
        if (to === null || from === to) continue;
        const paysItemPrice =
          ownPrice(state, skuId, storeId) === null && ownPrice(next, skuId, storeId) === null;
        if (visibleStoreIds === null && paysItemPrice) itemLine = true;
        else storeLines.push({ kind: 'priceAfterReceipt', skuId, storeId, at, from, to, reason });
      }
      if (itemLine) {
        out.push({
          kind: 'priceAfterReceipt',
          skuId,
          storeId: null,
          at,
          from: before?.unitPrice ?? null,
          to: e.payload.unitPrice,
          reason,
        });
      }
      out.push(...storeLines);
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
          if (sp.storeId === storeId)
            confirmedQty.set(`${storeId}|${item.skuId}`, qtyMilliOrZero(sp.qty));
        }
      }
    }
  }

  for (const item of state.items.values()) {
    if (item.status !== 'purchased') continue;
    for (const sp of item.storeSplits) {
      if (!confirmedStores.has(sp.storeId) || !visible(sp.storeId)) continue;
      const added =
        qtyMilliOrZero(sp.qty) - (confirmedQty.get(`${sp.storeId}|${item.skuId}`) ?? 0n);
      if (added <= 0n) continue;
      out.push({
        kind: 'amendAdded',
        skuId: item.skuId,
        storeId: sp.storeId,
        qty: milliQty(added),
      });
    }
  }
  return out;
}
