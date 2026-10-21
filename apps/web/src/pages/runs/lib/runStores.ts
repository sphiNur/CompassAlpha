/**
 * Store scope helpers for the Run page (2026-10-21 audit CA-29).
 *
 * The purchase sheet used to offer every store the purchaser can buy for,
 * so goods could be split to a store that has no order in the run — that
 * store never sees the run, cannot confirm it, and FinishRun stays blocked.
 * The server now rejects such splits; these helpers keep the UI from
 * offering them in the first place.
 */

interface RunStoreSource {
  sessions?: ReadonlyArray<{ storeId: string }> | null;
  perStoreDemand?: ReadonlyArray<{ storeId: string }> | null;
  splits?: ReadonlyArray<{ storeId: string }> | null;
}

/** Every store the run serves: its order sessions, demand and splits. */
export function runStoreIdsOf(detail: RunStoreSource | null | undefined): string[] {
  const ids = new Set<string>();
  for (const s of detail?.sessions ?? []) ids.add(s.storeId);
  for (const d of detail?.perStoreDemand ?? []) ids.add(d.storeId);
  for (const sp of detail?.splits ?? []) ids.add(sp.storeId);
  return [...ids];
}

type Split = { storeId: string; qty: string };

/**
 * 2026-10-21 audit CA-29 (C-05): the splits to submit when the "add item"
 * sheet merges a new store into a SKU that is already in the run.
 *
 * - `pending`: nothing has been bought yet, so the run has no splits for
 *   the SKU. The base is the other stores' ordered demand — without it,
 *   marking the row purchased for just the new store silently dropped
 *   their demand.
 * - `purchased`: the base is the recorded splits.
 *
 * A store present in both is summed rather than listed twice.
 */
export function mergeSplitsIntoExistingItem(input: {
  status: string;
  existingSplits: ReadonlyArray<Split>;
  demand: ReadonlyArray<Split>;
  newSplits: ReadonlyArray<Split>;
}): { splits: Split[]; totalQty: string } {
  const base = input.status === 'pending' ? input.demand : input.existingSplits;
  const byStore = new Map<string, number>();
  for (const sp of [...base, ...input.newSplits]) {
    const qty = Number(sp.qty);
    if (!(qty > 0)) continue;
    byStore.set(sp.storeId, (byStore.get(sp.storeId) ?? 0) + qty);
  }
  const splits = [...byStore.entries()].map(([storeId, qty]) => ({
    storeId,
    qty: roundQty(qty),
  }));
  // Sum the rounded splits so the server's split-sum check always holds.
  const total = splits.reduce((s, sp) => s + Number(sp.qty), 0);
  return { splits, totalQty: roundQty(total) };
}

/** Three decimals, matching the qty precision used across the run. */
function roundQty(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}
