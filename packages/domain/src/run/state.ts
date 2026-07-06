import type { RunEvent, StoreSplitPayload } from './events';

/**
 * `amending` (2026-07-06): a FINISHED run reopened by a super-admin
 * (permission `run.amend`) to correct records after the fact — wrong
 * price typed, missing item, duplicate. Reached only via RunReopened
 * (finished → amending) and left only via RunRefinalized (amending →
 * finished, totals recomputed). While amending, the normal edit
 * commands are permitted for `run.amend` holders and the frozen totals
 * are stale until refinalize re-freezes them. It is a transient,
 * privileged state — not part of the normal purchase lifecycle.
 */
export type RunStatus =
  | 'absent'
  | 'planned'
  | 'purchasing'
  | 'delivering'
  | 'finished'
  | 'amending'
  | 'cancelled';

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
  storeSplits: StoreSplitPayload[];
  /** M1.14: payment method recorded at purchase. Null while the item
   *  is still pending or unavailable. Defaults to `cash` when applying
   *  pre-M1.14 events that didn't carry the field. */
  paymentMethod: PaymentMethod | null;
  /**
   * M3.41 (2026-05-21): true when the purchaser added this row mid-run
   * (PurchaserItemAdded event) — i.e. the SKU was NOT in the original
   * aggregated demand. Reports / finish summary distinguish these from
   * planned items so the manager can see "ordered" vs "added beyond
   * the ask". False / undefined for rows that came from RunPlanned or
   * SessionsAttachedToRun. The reason for the addition lives only in
   * the event log (not denormalized into state) to keep the row shape
   * small — audit lookup walks the event stream when needed.
   */
  addedByPurchaser?: boolean;
}

/**
 * M3.44 (2026-05-22): off-catalog expense recorded by the purchaser.
 * Different from RunItemState — no SKU foreign key, no delivery /
 * confirmation lifecycle, no price_history side effect. Free-text
 * label is the identity; expenseId is client-generated for
 * idempotency.
 */
export interface RunExpense {
  id: string;
  label: string;
  unitHint: string | null;
  qty: string;
  unitPrice: string;
  storeSplits: Array<{ storeId: string; qty: string }>;
  paymentMethod: PaymentMethod;
  receiptPhotoUrl: string | null;
  reason: string;
  addedByMemberId: string;
  addedAt: Date;
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
  /**
   * M3.44 (2026-05-22): off-catalog expenses added by the purchaser
   * (free-text label / porter fee / one-off items). Insertion order
   * preserved; soft-removed entries are dropped from this array (the
   * RunExpenseRemoved event triggers the splice).
   */
  expenses: RunExpense[];
  finishedAt: Date | null;
  /**
   * Run-level claim — C.2 (M3.38, 2026-05-19). Holds the purchaser who
   * has the run "open" right now. Null when unclaimed (the default for
   * a fresh run, and after self/timeout release). Mutations during
   * planned/purchasing/delivering require either no claim or claim
   * ownership.
   */
  claimedByMemberId: string | null;
  claimedAt: Date | null;
  /**
   * Snapshot of the last forcibly-released claimer (override or
   * timeout). Lets the take-over banner show "原 X → 现 Y". Cleared
   * on manual self-release / pagehide / terminal status transitions.
   */
  previousClaimerMemberId: string | null;
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
    expenses: [],
    finishedAt: null,
    claimedByMemberId: null,
    claimedAt: null,
    previousClaimerMemberId: null,
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
    case 'PurchaserItemAdded': {
      // M3.41 (2026-05-21): purchaser added a SKU mid-run. Create a fresh
      // RunItemState marked `addedByPurchaser=true`. plannedQty=actualQty
      // because the "plan" for an added item IS what was bought — there's
      // no prior aggregated demand to compare against. The shape mirrors
      // ItemPurchased's outcome so downstream UI / reports treat it as a
      // purchased row, just with the extra flag set.
      const items = new Map(state.items);
      items.set(event.payload.skuId, {
        skuId: event.payload.skuId,
        plannedQty: event.payload.actualQty,
        purchasedQty: event.payload.actualQty,
        supplierId: event.payload.supplierId,
        unitPrice: event.payload.unitPrice,
        status: 'purchased',
        unavailableNote: null,
        receiptPhotoUrl: event.payload.receiptPhotoUrl,
        storeSplits: event.payload.storeSplits,
        paymentMethod: event.payload.paymentMethod,
        addedByPurchaser: true,
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
      // C.2 (M3.38): terminal — drop the claim so the audit trail
      // doesn't leave a stale "claimed by X" snapshot on a finished
      // run. Same for cancelled below.
      return {
        ...state,
        seq: event.seq,
        status: 'finished',
        finishedAt: event.occurredAt,
        claimedByMemberId: null,
        claimedAt: null,
        previousClaimerMemberId: null,
      };
    case 'RunCancelled':
      return {
        ...state,
        seq: event.seq,
        status: 'cancelled',
        claimedByMemberId: null,
        claimedAt: null,
        previousClaimerMemberId: null,
      };
    case 'RunReopened':
      // Super-admin reopened a finished run for correction. Item / split
      // / expense state is untouched — only the phase moves back so the
      // edit commands unlock. The frozen totals on the read model are
      // now stale until RunRefinalized re-freezes them.
      return { ...state, seq: event.seq, status: 'amending' };
    case 'RunRefinalized':
      // Correction session closed. Totals were recomputed from the
      // amended state (same math as RunFinished) and carried on the
      // event; the reducer just moves the phase back to finished.
      return {
        ...state,
        seq: event.seq,
        status: 'finished',
        finishedAt: event.occurredAt,
      };

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
    case 'RunExpenseAdded': {
      // M3.44 (2026-05-22): off-catalog expense. Append-only; the row
      // is removed via a follow-up RunExpenseRemoved event (soft-delete
      // semantics inside the state — the original Added event stays
      // in the log for audit). Idempotent if the same expenseId
      // already exists (e.g. replay of a stalled mutation).
      if (state.expenses.some((e) => e.id === event.payload.expenseId)) {
        return { ...state, seq: event.seq };
      }
      const newExpense: RunExpense = {
        id: event.payload.expenseId,
        label: event.payload.label,
        unitHint: event.payload.unitHint,
        qty: event.payload.qty,
        unitPrice: event.payload.unitPrice,
        storeSplits: event.payload.storeSplits,
        paymentMethod: event.payload.paymentMethod,
        receiptPhotoUrl: event.payload.receiptPhotoUrl,
        reason: event.payload.reason,
        addedByMemberId: event.payload.byMemberId,
        addedAt: event.occurredAt,
      };
      return {
        ...state,
        seq: event.seq,
        expenses: [...state.expenses, newExpense],
      };
    }
    case 'RunExpenseRemoved': {
      // Soft-delete in state (dropped from the array). The audit log
      // still has both the Added and Removed events for forensics.
      return {
        ...state,
        seq: event.seq,
        expenses: state.expenses.filter((e) => e.id !== event.payload.expenseId),
      };
    }
    case 'RunClaimed':
      // C.2 (M3.38): the take-over button also writes RunClaimed —
      // payload.byMemberId is the new claimer, the prior claimer was
      // released by an immediately-preceding RunClaimReleased event
      // (which already cleared claimedByMemberId and set
      // previousClaimerMemberId via the projection). So this reducer
      // just sets the new owner and timestamp.
      return {
        ...state,
        seq: event.seq,
        claimedByMemberId: event.payload.byMemberId,
        claimedAt: event.occurredAt,
      };
    case 'RunClaimReleased': {
      // C.2 (M3.38): snapshot the prior claimer when the release was
      // FORCED (override / timeout) so the next purchaser's banner
      // can render "X → Y". Self-releases (manual/pagehide) clear
      // the snapshot so the next claim has a clean slate.
      const remembersOverride =
        event.payload.reason === 'override' || event.payload.reason === 'timeout';
      return {
        ...state,
        seq: event.seq,
        claimedByMemberId: null,
        claimedAt: null,
        previousClaimerMemberId: remembersOverride ? state.claimedByMemberId : null,
      };
    }
    case 'SessionsAttachedToRun': {
      // M3.31 A.2 (2026-05-18): merge additional demand into the run.
      // Existing items grow in plannedQty; new SKUs get fresh pending
      // rows. NEVER touch purchasedQty / status / unitPrice — those
      // belong to the buyer's decisions. Numeric add as JS number is
      // fine here: qty strings flow from the run.create aggregation
      // which already does this kind of accumulation.
      const items = new Map(state.items);
      for (const p of event.payload.addedPlannedItems) {
        const existing = items.get(p.skuId);
        if (existing) {
          const merged = (Number(existing.plannedQty) + Number(p.qty)).toString();
          items.set(p.skuId, { ...existing, plannedQty: merged });
        } else {
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
      }
      return {
        ...state,
        seq: event.seq,
        sessionIds: [...state.sessionIds, ...event.payload.sessionIds],
        items,
      };
    }

    case 'SessionEjectedFromRun': {
      const items = new Map(state.items);
      for (const removed of event.payload.removedPlannedItems) {
        const existing = items.get(removed.skuId);
        if (!existing) continue;
        const remaining = Number(existing.plannedQty) - Number(removed.qty);
        if (remaining <= 1e-6) {
          items.delete(removed.skuId);
        } else {
          items.set(removed.skuId, { ...existing, plannedQty: remaining.toString() });
        }
      }
      return {
        ...state,
        seq: event.seq,
        sessionIds: state.sessionIds.filter((id) => id !== event.payload.sessionId),
        items,
      };
    }

    default: {
      const _x: never = event;
      void _x;
      return state;
    }
  }
}
