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

type PaymentMethod = 'cash' | 'transfer';
type RevisionSplit = {
  storeId: string;
  qty: string;
  unitPrice?: string;
  paymentMethod?: PaymentMethod;
};

function asPaymentMethod(v: string | null | undefined): PaymentMethod | null {
  return v === 'cash' || v === 'transfer' ? v : null;
}

/**
 * 2026-10-21 FE-04 (F3-07): the revisePurchase payload for "merge into
 * existing row" on an already-PURCHASED item.
 *
 * revisePurchase rewrites the whole purchase, and the add-item sheet has
 * no supplier control (its draft supplier/receipt are usually null), so
 * sending the draft as-is wiped the row's supplier, receipt and every
 * store's price/payment override. Instead the existing row is the base:
 *
 * - item-level supplierId / unitPrice / paymentMethod are kept;
 * - the receipt is kept unless the draft brings a new one;
 * - existing splits keep their qty and overrides (run.get reports an
 *   override as a non-null split unitPrice / paymentMethod);
 * - the new store's split is appended, carrying the draft price / payment
 *   as an override only when they differ from the item-level values.
 *
 * A store present in both is summed and keeps its existing overrides
 * (the sheet routes that case to a separate expense, so it is defensive).
 */
export function mergeIntoPurchasedItem(input: {
  item: {
    unitPrice: string | null;
    purchasedQty?: string | null;
    supplierId?: string | null;
    receiptPhotoUrl?: string | null;
    paymentMethod?: string | null;
  };
  existingSplits: ReadonlyArray<{
    storeId: string;
    qty: string;
    unitPrice?: string | null;
    paymentMethod?: string | null;
  }>;
  newSplits: ReadonlyArray<Split>;
  draft: {
    unitPrice: string;
    paymentMethod: PaymentMethod;
    supplierId: string | null;
    receiptPhotoUrl: string | null;
  };
}): {
  supplierId: string | null;
  unitPrice: string;
  paymentMethod: PaymentMethod;
  receiptPhotoUrl: string | null;
  storeSplits: RevisionSplit[];
  actualQty: string;
} {
  const { item, draft } = input;
  const unitPrice = item.unitPrice && Number(item.unitPrice) > 0 ? item.unitPrice : draft.unitPrice;
  const paymentMethod = asPaymentMethod(item.paymentMethod) ?? draft.paymentMethod;
  const byStore = new Map<
    string,
    { qty: number; unitPrice?: string; paymentMethod?: PaymentMethod }
  >();
  for (const sp of input.existingSplits) {
    const qty = Number(sp.qty);
    if (!(qty > 0)) continue;
    const cur = byStore.get(sp.storeId);
    if (cur) {
      cur.qty += qty;
      continue;
    }
    const pm = asPaymentMethod(sp.paymentMethod);
    byStore.set(sp.storeId, {
      qty,
      ...(sp.unitPrice ? { unitPrice: sp.unitPrice } : {}),
      ...(pm ? { paymentMethod: pm } : {}),
    });
  }
  const draftPriceDiffers =
    Number(draft.unitPrice) > 0 && Number(draft.unitPrice) !== Number(unitPrice);
  for (const sp of input.newSplits) {
    const qty = Number(sp.qty);
    if (!(qty > 0)) continue;
    const cur = byStore.get(sp.storeId);
    if (cur) {
      cur.qty += qty;
      continue;
    }
    byStore.set(sp.storeId, {
      qty,
      ...(draftPriceDiffers ? { unitPrice: draft.unitPrice } : {}),
      ...(draft.paymentMethod !== paymentMethod ? { paymentMethod: draft.paymentMethod } : {}),
    });
  }
  const storeSplits: RevisionSplit[] = [...byStore.entries()].map(([storeId, v]) => ({
    storeId,
    qty: roundQty(v.qty),
    ...(v.unitPrice !== undefined ? { unitPrice: v.unitPrice } : {}),
    ...(v.paymentMethod !== undefined ? { paymentMethod: v.paymentMethod } : {}),
  }));
  const total = storeSplits.reduce((s, sp) => s + Number(sp.qty), 0);
  return {
    supplierId: item.supplierId ?? draft.supplierId,
    unitPrice,
    paymentMethod,
    receiptPhotoUrl: draft.receiptPhotoUrl ?? item.receiptPhotoUrl ?? null,
    storeSplits,
    actualQty: roundQty(total),
  };
}
