/**
 * Market run event catalog. Same patterns as order: append-only, payload
 * schema is contract — bump TYPE on breaking change.
 */

interface BaseEvent {
  streamId: string;
  seq: number;
  occurredAt: Date;
  actorUserId: string | null;
  actorMemberId: string | null;
  correlationId?: string | undefined;
  causationId?: string | undefined;
}

export type RunEvent =
  | (BaseEvent & {
      type: 'RunPlanned';
      payload: {
        orgId: string;
        runDate: string;
        runIndex: number;
        sessionIds: string[];
        plannedItems: Array<{ skuId: string; qty: string }>;
        purchaserMemberId: string;
      };
    })
  | (BaseEvent & {
      type: 'PurchaseStarted';
      payload: Record<string, never>;
    })
  | (BaseEvent & {
      type: 'ItemPurchased';
      payload: {
        skuId: string;
        supplierId: string | null;
        unitPrice: string;
        actualQty: string;
        receiptPhotoUrl: string | null;
        storeSplits: Array<{ storeId: string; qty: string }>;
      };
    })
  | (BaseEvent & {
      type: 'ItemUnavailable';
      payload: { skuId: string; note: string };
    })
  | (BaseEvent & {
      type: 'DeliveryStarted';
      payload: Record<string, never>;
    })
  | (BaseEvent & {
      type: 'StoreDelivered';
      payload: { storeId: string; deliveredByUserId: string };
    })
  | (BaseEvent & {
      type: 'StoreItemConfirmed';
      payload: {
        storeId: string;
        skuId: string;
        status: 'ok' | 'short' | 'wrong' | 'quality';
        note: string | null;
        photoUrl: string | null;
      };
    })
  | (BaseEvent & {
      type: 'StoreConfirmed';
      payload: { storeId: string; confirmedByUserId: string };
    })
  | (BaseEvent & {
      type: 'RunFinished';
      payload: { totalActual: string };
    })
  | (BaseEvent & {
      type: 'RunCancelled';
      // M1.7 (2026-05-07): reason is optional now. Old events on
      // existing streams carry a non-null string; new cancels may
      // arrive with null when the operator left the field blank.
      payload: { reason: string | null };
    })
  // ---- Reversal / "undo" events (added 2026-05-03) ---------------------
  // Event sourcing: we never delete or rewrite events. Reversal is a NEW
  // forward event that collapses a previous decision. The `applyRun`
  // reducer interprets these to roll the in-memory state back. The
  // append-only ledger therefore preserves a complete audit of who
  // decided what AND who changed their mind.
  | (BaseEvent & {
      // Replaces the data captured in a prior ItemPurchased for the same
      // SKU. Allowed in `purchasing` (always) and in `delivering` when
      // none of this SKU's destination stores have been delivered yet.
      type: 'PurchaseRevised';
      payload: {
        skuId: string;
        supplierId: string | null;
        unitPrice: string;
        actualQty: string;
        receiptPhotoUrl: string | null;
        storeSplits: Array<{ storeId: string; qty: string }>;
        // Why we're revising — short free-text, ≤500 chars. Required so
        // an audit can answer "why did this change?" later.
        reason: string;
      };
    })
  | (BaseEvent & {
      // Restores a SKU previously marked unavailable back to pending.
      // The original ItemUnavailable event remains in the log.
      type: 'UnavailableUndone';
      payload: { skuId: string; reason: string };
    })
  | (BaseEvent & {
      // Reverts a previously-purchased SKU back to pending. Used when
      // the purchaser realises after the fact that a recorded buy was
      // wrong (mistapped wrong row, decided not to buy after all,
      // returning to supplier, etc.). Blocked once any destination
      // store has accepted delivery — same rule as RevisePurchase.
      // The original ItemPurchased event remains in the audit log.
      type: 'PurchaseUndone';
      payload: { skuId: string; reason: string };
    })
  | (BaseEvent & {
      // Retracts a StoreDelivered for a store that has not yet been
      // confirmed. Used when the dispatcher tapped the wrong store row.
      type: 'StoreDeliveryUndone';
      payload: { storeId: string; reason: string };
    })
  | (BaseEvent & {
      // Retracts PurchaseStarted, allowed only if NO item has been
      // purchased OR marked unavailable yet — i.e. nothing real has
      // happened since starting the purchase phase. Run goes back to
      // `planned`.
      type: 'PurchaseStartUndone';
      payload: { reason: string };
    })
  | (BaseEvent & {
      // Retracts DeliveryStarted, allowed only if no StoreDelivered has
      // been emitted. Run goes back to `purchasing`.
      type: 'DeliveryStartUndone';
      payload: { reason: string };
    });
