import type { RunEvent } from './events';

export type RunStatus = 'absent' | 'planned' | 'purchasing' | 'delivering' | 'finished' | 'cancelled';

/**
 * Payment method for a recorded purchase. M1.14 (2026-05-08).
 * - `cash`: handed cash at the market stall / shop counter
 * - `transfer`: bank wire / online payment to supplier
 * A single run can mix both methods across different items (and even
 * the same SKU revised between methods). FinishRun aggregates per-
 * method totals so the chain owner can reconcile petty cash vs. bank
 * statements separately.
 */
export type PaymentMethod = 'cash' | 'transfer';

export interface RunItemState {
  skuId: string;
  plannedQty: string;
  purchasedQty: string | null;
  supplierId: string | null;
  unitPrice: string | null;
  status: 'pending' | 'purchased' | 'unavailable';
  unavailableNote: string | null;
  receiptPhotoUrl: string | null;
  storeSplits: Array<{ storeId: string; qty: string }>;
  /** M1.14: payment method recorded at purchase. Null while the item
   *  is still pending or unavailable. Defaults to `cash` when applying
   *  pre-M1.14 events that didn't carry the field. */
  paymentMethod: PaymentMethod | null;
}

export interface RunStoreDeliveryState {
  storeId: string;
  deliveredAt: Date | null;
  deliveredByUserId: string | null;
  confirmedAt: Date | null;
  confirmedByUserId: string | null;
  itemConfirms: Map<string, { status: string; note: string | null; photoUrl: string | null }>;
}

export interface RunState {
  status: RunStatus;
  streamId: string;
  seq: number;
  orgId: string | null;
  runDate: string | null;
  runIndex: number;
  sessionIds: string[];
  purchaserMemberId: string | null;
  items: Map<string, RunItemState>;
  stores: Map<string, RunStoreDeliveryState>;
  finishedAt: Date | null;
}

export function emptyRunState(streamId: string): RunState {
  return {
    status: 'absent',
    streamId,
    seq: 0,
    orgId: null,
    runDate: null,
    runIndex: 0,
    sessionIds: [],
    purchaserMemberId: null,
    items: new Map(),
    stores: new Map(),
    finishedAt: null,
  };
}

export function applyRun(state: RunState, event: RunEvent): RunState {
  if (event.seq !== state.seq + 1) {
    throw new Error(`applyRun(): seq gap on ${state.streamId}: have ${state.seq}, got ${event.seq}`);
  }
  switch (event.type) {
    case 'RunPlanned': {
      const items = new Map<string, RunItemState>();
      for (const p of event.payload.plannedItems) {
        items.set(p.skuId, {
          skuId: p.skuId,
          plannedQty: p.qty,
          purchasedQty: null,
          supplierId: null,
          unitPrice: null,
          status: 'pending',
          unavailableNote: null,
          receiptPhotoUrl: null,
          storeSplits: [],
          paymentMethod: null,
        });
      }
      return {
        ...state,
        seq: event.seq,
        status: 'planned',
        orgId: event.payload.orgId,
        runDate: event.payload.runDate,
        runIndex: event.payload.runIndex,
        sessionIds: event.payload.sessionIds,
        purchaserMemberId: event.payload.purchaserMemberId,
        items,
      };
    }
    case 'PurchaseStarted':
      return { ...state, seq: event.seq, status: 'purchasing' };
    case 'ItemPurchased': {
      const items = new Map(state.items);
      const existing = items.get(event.payload.skuId);
      if (!existing) return { ...state, seq: event.seq };
      items.set(event.payload.skuId, {
        ...existing,
        status: 'purchased',
        purchasedQty: event.payload.actualQty,
        supplierId: event.payload.supplierId,
        unitPrice: event.payload.unitPrice,
        receiptPhotoUrl: event.payload.receiptPhotoUrl,
        storeSplits: event.payload.storeSplits,
        // M1.14: legacy events default to cash (the assumption before
        // payment method was tracked). Forward events always carry a
        // value, so the ?? is a one-time projection-time backfill.
        paymentMethod: event.payload.paymentMethod ?? 'cash',
      });
      return { ...state, seq: event.seq, items };
    }
    case 'ItemUnavailable': {
      const items = new Map(state.items);
      const existing = items.get(event.payload.skuId);
      if (!existing) return { ...state, seq: event.seq };
      items.set(event.payload.skuId, {
        ...existing,
        status: 'unavailable',
        unavailableNote: event.payload.note,
      });
      return { ...state, seq: event.seq, items };
    }
    case 'DeliveryStarted':
      return { ...state, seq: event.seq, status: 'delivering' };
    case 'StoreDelivered': {
      const stores = new Map(state.stores);
      const existing =
        stores.get(event.payload.storeId) ??
        ({
          storeId: event.payload.storeId,
          deliveredAt: null,
          deliveredByUserId: null,
          confirmedAt: null,
          confirmedByUserId: null,
          itemConfirms: new Map(),
        } satisfies RunStoreDeliveryState);
      stores.set(event.payload.storeId, {
        ...existing,
        deliveredAt: event.occurredAt,
        deliveredByUserId: event.payload.deliveredByUserId,
      });
      return { ...state, seq: event.seq, stores };
    }
    case 'StoreItemConfirmed': {
      const stores = new Map(state.stores);
      const existing =
        stores.get(event.payload.storeId) ??
        ({
          storeId: event.payload.storeId,
          deliveredAt: null,
          deliveredByUserId: null,
          confirmedAt: null,
          confirmedByUserId: null,
          itemConfirms: new Map(),
        } satisfies RunStoreDeliveryState);
      const confirms = new Map(existing.itemConfirms);
      confirms.set(event.payload.skuId, {
        status: event.payload.status,
        note: event.payload.note,
        photoUrl: event.payload.photoUrl,
      });
      stores.set(event.payload.storeId, { ...existing, itemConfirms: confirms });
      return { ...state, seq: event.seq, stores };
    }
    case 'StoreConfirmed': {
      const stores = new Map(state.stores);
      const existing = stores.get(event.payload.storeId);
      if (!existing) return { ...state, seq: event.seq };
      stores.set(event.payload.storeId, {
        ...existing,
        confirmedAt: event.occurredAt,
        confirmedByUserId: event.payload.confirmedByUserId,
      });
      return { ...state, seq: event.seq, stores };
    }
    case 'RunFinished':
      return { ...state, seq: event.seq, status: 'finished', finishedAt: event.occurredAt };
    case 'RunCancelled':
      return { ...state, seq: event.seq, status: 'cancelled' };

    // ---- Reversal events (added 2026-05-03) -----------------------------
    case 'PurchaseRevised': {
      // Same shape as ItemPurchased's reduce, but never changes the item
      // status (must already be 'purchased' to revise — guarded in
      // decideRun). Crucially, replaces storeSplits wholesale; the
      // projector does the corresponding row-delete in the read model.
      const items = new Map(state.items);
      const existing = items.get(event.payload.skuId);
      if (!existing) return { ...state, seq: event.seq };
      items.set(event.payload.skuId, {
        ...existing,
        purchasedQty: event.payload.actualQty,
        supplierId: event.payload.supplierId,
        unitPrice: event.payload.unitPrice,
        receiptPhotoUrl: event.payload.receiptPhotoUrl,
        storeSplits: event.payload.storeSplits,
        // M1.14: keep prior method when the legacy event omits it.
        paymentMethod:
          event.payload.paymentMethod ?? existing.paymentMethod ?? 'cash',
      });
      return { ...state, seq: event.seq, items };
    }
    case 'UnavailableUndone': {
      const items = new Map(state.items);
      const existing = items.get(event.payload.skuId);
      if (!existing) return { ...state, seq: event.seq };
      items.set(event.payload.skuId, {
        ...existing,
        status: 'pending',
        unavailableNote: null,
      });
      return { ...state, seq: event.seq, items };
    }
    case 'PurchaseUndone': {
      const items = new Map(state.items);
      const existing = items.get(event.payload.skuId);
      if (!existing) return { ...state, seq: event.seq };
      items.set(event.payload.skuId, {
        ...existing,
        status: 'pending',
        purchasedQty: null,
        supplierId: null,
        unitPrice: null,
        receiptPhotoUrl: null,
        storeSplits: [],
        // M1.14: clear payment method on undo so re-purchase records a
        // fresh choice rather than inheriting a stale one.
        paymentMethod: null,
      });
      return { ...state, seq: event.seq, items };
    }
    case 'StoreDeliveryUndone': {
      const stores = new Map(state.stores);
      const existing = stores.get(event.payload.storeId);
      if (!existing) return { ...state, seq: event.seq };
      stores.set(event.payload.storeId, {
        ...existing,
        deliveredAt: null,
        deliveredByUserId: null,
        // Item-level confirms WERE not allowed before delivered (server-
        // side guarded), but be defensive: clear them too so the store
        // page renders the correct affordances after undo.
        itemConfirms: new Map(),
      });
      return { ...state, seq: event.seq, stores };
    }
    case 'PurchaseStartUndone':
      return { ...state, seq: event.seq, status: 'planned' };
    case 'DeliveryStartUndone':
      return { ...state, seq: event.seq, status: 'purchasing' };

    default: {
      const _x: never = event;
      void _x;
      return state;
    }
  }
}
