/**
 * Shared run-domain types (Phase 4 step 4 — FRONTEND_AUDIT_2026-07.md).
 *
 * ActiveRun is the FE-side shape of run.get's payload that the
 * orchestrator (RunPage) and every grouped view / row leaf agree on.
 * Moved verbatim out of RunPage.tsx so runs/views can import it without
 * reaching back into the god-file.
 */
/**
 * Preview-shaped rows for the pre-run summary card (整体 / 按店铺 /
 * 按摊位). Moved here from RunPanels.tsx (2026-07-26) so `runs/lib`
 * can build the share-text strings as pure, testable functions instead
 * of closures trapped inside the component.
 */
export type PreviewLine = {
  id: string;
  kind: 'sku' | 'extra';
  skuId: string | null;
  name: string;
  qty: string;
  unit: string;
  unitPrice: string | null;
  total: number | null;
  note?: string;
  /**
   * Preferred stall for this SKU, resolved ONCE when the line is built
   * (2026-07-26). Null for extras — an off-catalog item has no SKU and so
   * can never carry a supplier link — and for SKUs nobody has assigned.
   * The by-supplier grouping reads this instead of re-resolving, so the
   * two views cannot disagree about where an item comes from.
   */
  supplierId?: string | null;
  supplierName?: string | null;
};

export type PreviewStoreGroup = {
  storeId: string;
  storeName: string;
  items: PreviewLine[];
  total: number;
  unknownCount: number;
  legacyNote?: string;
};

export type PreviewSupplierGroup = {
  supplierId: string | null;
  supplierName: string;
  contactPhone: string | null;
  contactTg: string | null;
  stores: PreviewStoreGroup[];
  total: number;
  unknownCount: number;
};

export interface ActiveRun {
  id: string;
  status: string;
  /** DLV-14: stores this actor may not dispatch to (store-scoped deny). */
  dispatchDeniedStoreIds?: string[];
  /** BUY-6: stores this actor purchases for; null/absent = all. */
  purchaseScopeStoreIds?: string[] | null;
  /** BUY-6: items that also serve stores outside that scope (read-only). */
  otherStoreSkuIds?: string[];
  /** D9: expenses split to stores outside that scope (not removable). */
  otherStoreExpenseIds?: string[];
  /** RE-DLV-3: why finish (or closing a correction) would be refused for
   *  this actor, as an error key; null/absent = not refused. */
  finishBlockedReason?: string | null;
  items: Array<{
    skuId: string;
    plannedQty: string;
    purchasedQty: string | null;
    status: string;
    unavailableNote: string | null;
    unitPrice: string | null;
    supplierId?: string | null;
    receiptPhotoUrl?: string | null;
    /** M1.14: 'cash' | 'transfer'. Optional because legacy data
     *  pre-migration may be missing the column on rare occasions; the
     *  inline row defaults to 'cash' when undefined. */
    paymentMethod?: string | null;
    /** M3.41 (2026-05-21): true when this row was added mid-run by the
     *  purchaser via AddPurchaserItem. Drives the "+" badge on the row
     *  and the breakdown in finish summary. Default false. */
    addedByPurchaser?: boolean;
    /** BUY-5: demand that joined after the item was decided. */
    topUpQty?: string | null;
    /** R2-INT-1: a queued (offline) purchase or mark, not yet synced. */
    pendingSync?: boolean;
  }>;
  splits: Array<{
    runId: string;
    skuId: string;
    storeId: string;
    qty: string;
    unitPrice?: string | null;
    paymentMethod?: string | null;
    deliveredAt: Date | string | null;
    confirmedAt: Date | string | null;
    /** Receiver's per-line status (ok | short | wrong | quality). */
    confirmStatus?: string | null;
    /** 2026-10-21 CA-06: qty actually received on a problem line. */
    confirmReceivedQty?: string | null;
    /** DLV-7: the receiver's note and photo on a problem line. */
    confirmNote?: string | null;
    confirmPhotoUrl?: string | null;
    /** R2-INT-1: a queued (offline) change to this split, not yet synced. */
    pendingSync?: boolean;
  }>;
  perStoreDemand?: Array<{ storeId: string; skuId: string; qty: string }>;
  sessions?: Array<{
    id: string;
    storeId: string;
    submittedByMemberId: string | null;
    initiatedByMemberId: string | null;
    submittedByDisplayName: string | null;
    itemCount: number;
    totalQty: string;
    extrasCount: number;
    status: string;
  }>;
  lastPriceBySku?: Record<string, string>;
  /**
   * When each reference price was observed (ISO). Parallel to
   * lastPriceBySku rather than folded into it: that map feeds the
   * inline price prefill in three places, and reshaping the money path
   * to carry a timestamp is a bad trade for a display concern.
   */
  lastPriceObservedAtBySku?: Record<string, string>;
  /** M1.8: per-store concatenated session notes ("其他物品", legacy). */
  sessionNotesByStore?: Record<string, string>;
  /** M3.16-C: per-store structured extras ("其他物品" rows).
   *  M3.37: each row now also carries `sessionId` + `idx` + optional
   *  `status` so the FE can route taps into `order.markExtraStatus`. */
  sessionExtrasByStore?: Record<
    string,
    Array<{
      name: string;
      qty: string;
      unit: string;
      note?: string;
      status?: 'pending' | 'bought' | 'unavailable';
      sessionId?: string;
      idx?: number;
      /** APR-18: the session's lastSeq, sent back as expectedSeq. */
      sessionSeq?: number;
    }>
  >;
  /** 2026-10-21 CA-11: server-computed items / expenses / total (run.get). */
  money?: { itemsTotal: string; expensesTotal: string; total: string };
  /** M3.44 (2026-05-22): active (non-removed) off-catalog expenses. */
  expenses?: Array<{
    id: string;
    label: string;
    unitHint: string | null;
    qty: string;
    unitPrice: string;
    storeSplits: Array<{
      storeId: string;
      qty: string;
      unitPrice?: string;
      paymentMethod?: 'cash' | 'transfer';
    }>;
    paymentMethod: string;
    receiptPhotoUrl: string | null;
    reason: string;
    addedByMemberId: string;
    addedAt: string;
    /** CMP-BUY-2: recorded offline, not on the server yet. */
    pendingSync?: boolean;
  }>;
  /** M3.27: preferred-supplier per SKU (mirrors preview.supplierBySku),
   *  powers the active-run "by vendor" view. Null entries = SKUs
   *  with no preferred link — bucketed under "unassigned" in the FE. */
  supplierBySku?: Record<
    string,
    {
      id: string;
      name: string;
      contactPhone: string | null;
      contactTg: string | null;
      defaultPrice?: string | null;
      lastSeenPrice?: string | null;
      estimatedUnitPrice?: string | null;
    } | null
  >;
}

const otherCache = new WeakMap<string[], ReadonlySet<string>>();
/** BUY-6: the read-only item set, stable per run.get payload. */
export function otherStoreSkusOf(run: Pick<ActiveRun, 'otherStoreSkuIds'>): ReadonlySet<string> {
  const ids = run.otherStoreSkuIds ?? [];
  let set = otherCache.get(ids);
  if (!set) {
    set = new Set(ids);
    otherCache.set(ids, set);
  }
  return set;
}
