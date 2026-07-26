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
    }>
  >;
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
