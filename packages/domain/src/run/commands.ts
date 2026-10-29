import { conflict, forbidden, preconditionFailed, validation } from '../shared/errors';
import type { Clock } from '../shared/clock';
import { systemClock } from '../shared/clock';
import type { RunEvent } from './events';
import type { RunState } from './state';

type StoreSplitCommand = {
  storeId: string;
  qty: string;
  unitPrice?: string;
  paymentMethod?: 'cash' | 'transfer';
};

export type RunCommand =
  | {
      type: 'PlanRun';
      orgId: string;
      runDate: string;
      runIndex: number;
      sessionIds: string[];
      plannedItems: Array<{ skuId: string; qty: string }>;
      actor: ActorCtx;
    }
  | { type: 'StartPurchase'; actor: ActorCtx }
  | {
      type: 'PurchaseItem';
      skuId: string;
      supplierId: string | null;
      unitPrice: string;
      actualQty: string;
      receiptPhotoUrl: string | null;
      storeSplits: StoreSplitCommand[];
      /**
       * M1.14: 'cash' | 'transfer'. Required by the FE form (defaults
       * to cash) so audit always knows which money path each item took.
       */
      paymentMethod: 'cash' | 'transfer';
      /** 2026-10-21 audit CA-29: see assertStoresWithinRun. */
      runStoreIds?: readonly string[];
      /** The purchaser confirmed a price far from the last one paid. */
      priceConfirmed?: boolean;
      actor: ActorCtx;
    }
  | { type: 'MarkUnavailable'; skuId: string; note: string; actor: ActorCtx }
  | { type: 'StartDelivery'; actor: ActorCtx }
  | { type: 'DeliverToStore'; storeId: string; runStoreIds?: readonly string[]; actor: ActorCtx }
  | {
      type: 'ConfirmStoreItem';
      storeId: string;
      skuId: string;
      status: 'ok' | 'short' | 'wrong' | 'quality';
      note: string | null;
      photoUrl: string | null;
      /**
       * 2026-10-21 CA-06: decimal string, 0 ≤ qty ≤ this store's split.
       * Required for 'short'; defaults to "0" for 'wrong'/'quality';
       * ignored for 'ok' (the full split arrived).
       */
      receivedQty?: string | null;
      actor: ActorCtx;
    }
  | { type: 'ConfirmStore'; storeId: string; actor: ActorCtx }
  | { type: 'FinishRun'; actor: ActorCtx }
  | { type: 'CancelRun'; reason: string; actor: ActorCtx }
  // Post-finish amendment (2026-07-06), super-admin only (run.amend).
  | { type: 'ReopenRun'; reason: string; actor: ActorCtx }
  | { type: 'RefinalizeRun'; actor: ActorCtx }
  // Correct the calendar date a run's spend is booked under (2026-07-30),
  // super-admin only (run.amend). See the RunDateChanged event docblock.
  // `runIndex`: the run's number on the new day (see RunDateChanged).
  | { type: 'ChangeRunDate'; runDate: string; runIndex?: number; actor: ActorCtx }
  // ---- Reversal commands (added 2026-05-03) ---------------------------
  | {
      type: 'RevisePurchase';
      skuId: string;
      supplierId: string | null;
      unitPrice: string;
      actualQty: string;
      receiptPhotoUrl: string | null;
      storeSplits: StoreSplitCommand[];
      reason: string;
      /** M1.14: revising can also flip payment method (e.g. operator
       *  realised they actually wired the supplier instead of paying
       *  cash). Required so the form always submits the current choice. */
      paymentMethod: 'cash' | 'transfer';
      /** 2026-10-21 audit CA-29: see assertStoresWithinRun. */
      runStoreIds?: readonly string[];
      /** The purchaser confirmed a price far from the last one paid. */
      priceConfirmed?: boolean;
      actor: ActorCtx;
    }
  | { type: 'UnmarkUnavailable'; skuId: string; reason: string; actor: ActorCtx }
  | { type: 'UndoPurchase'; skuId: string; reason?: string; actor: ActorCtx }
  | { type: 'UndeliverStore'; storeId: string; reason: string; actor: ActorCtx }
  | { type: 'UndoStartPurchase'; reason: string; actor: ActorCtx }
  | { type: 'UndoStartDelivery'; reason: string; actor: ActorCtx }
  | {
      // M3.31 A.2 (2026-05-18): attach approved sessions to a live run.
      // `addedPlannedItems` is the pre-aggregated qty delta the API
      // layer produced from the new sessions' orderItemsV rows; the
      // domain trusts it (same trust we extend to RunPlanned).
      type: 'AttachSessions';
      sessionIds: string[];
      addedPlannedItems: Array<{ skuId: string; qty: string }>;
      actor: ActorCtx;
    }
  | {
      // Remove one still-pending order session from a planned/purchasing
      // run and reduce the aggregated planned quantities accordingly.
      type: 'EjectSession';
      sessionId: string;
      removedPlannedItems: Array<{ skuId: string; qty: string }>;
      reason?: string;
      actor: ActorCtx;
    }
  | {
      /**
       * M3.41 (2026-05-21): purchaser adds a SKU mid-run that was NOT in
       * the original aggregated demand. Distinct from PurchaseItem (which
       * targets a pre-planned row) so the audit log + reports can
       * separate "what was asked for" from "what was bought beyond
       * the ask". See the matching event in events.ts.
       */
      type: 'AddPurchaserItem';
      skuId: string;
      supplierId: string | null;
      unitPrice: string;
      actualQty: string;
      receiptPhotoUrl: string | null;
      storeSplits: StoreSplitCommand[];
      paymentMethod: 'cash' | 'transfer';
      reason: string;
      /** 2026-10-21 audit CA-29: see assertStoresWithinRun. */
      runStoreIds?: readonly string[];
      /** The purchaser confirmed a price far from the last one paid. */
      priceConfirmed?: boolean;
      actor: ActorCtx;
    }
  // ---- Off-catalog expenses (M3.44, 2026-05-22) ----------------------
  | {
      /**
       * Purchaser records something not in the SKU catalog — a one-off
       * item ("a bag of napkins") OR a shared cost ("porter fee",
       * "taxi back"). Free-text label is the identity. expenseId is
       * client-generated so the FE knows it before save (no roundtrip)
       * AND the same logical add replays idempotently.
       */
      type: 'AddRunExpense';
      expenseId: string;
      label: string;
      unitHint?: string;
      qty: string;
      unitPrice: string;
      storeSplits: Array<{ storeId: string; qty: string }>;
      paymentMethod: 'cash' | 'transfer';
      receiptPhotoUrl: string | null;
      reason: string;
      /** 2026-10-21 audit CA-29: see assertStoresWithinRun. */
      runStoreIds?: readonly string[];
      actor: ActorCtx;
    }
  | {
      /** Purchaser deletes an expense before the run is finished. */
      type: 'RemoveRunExpense';
      expenseId: string;
      reason: string;
      actor: ActorCtx;
    }
  // ---- Run-level claim (C.2, M3.38, 2026-05-19) -----------------------
  | { type: 'ClaimRun'; actor: ActorCtx }
  | {
      type: 'ReleaseRunClaim';
      actor: ActorCtx;
      /** Self-releases pass 'manual' or 'pagehide'. The override path
       *  is a separate FE action — same command, the domain detects
       *  `actor.memberId !== state.claimedByMemberId` and re-tags the
       *  emitted event with `reason: 'override'`. Timeout releases are
       *  emitted directly by the worker, never via this command. */
      reason: 'manual' | 'pagehide';
    };

export interface ActorCtx {
  userId: string;
  memberId: string;
  permissions: ReadonlySet<string>;
}

const TOLERANCE = 1e-6;

export function decideRun(
  state: RunState,
  command: RunCommand,
  clock: Clock = systemClock,
): RunEvent[] {
  const now = clock.now();
  const baseFor = (offset: number) => ({
    streamId: state.streamId,
    seq: state.seq + offset,
    occurredAt: now,
    actorUserId: command.actor.userId,
    actorMemberId: command.actor.memberId,
  });

  switch (command.type) {
    case 'PlanRun': {
      // Per-STREAM guard only, and deliberately so: a decider sees one
      // aggregate, and "does this org already have another run open" is
      // not a fact about this stream. Note the consequence — for a fresh
      // run id `state.status` is always 'absent', so this check never
      // fires on a first PlanRun and provides no cross-run protection
      // whatsoever.
      //
      // That rule lives where it can be enforced atomically: the partial
      // unique index mrv_one_active_per_org_unique (migration 0035), with
      // run.create short-circuiting to the live run before it gets here.
      // If you come looking for a missing guard, it is not missing.
      // 2026-10-21 CA-04: migration 0047 narrows that index to
      // planned/purchasing, so one run may be buying while any number of
      // earlier runs are still out for delivery / awaiting confirmation.
      if (state.status !== 'absent') {
        throw conflict('run.errors.alreadyPlanned', { status: state.status });
      }
      if (!command.actor.permissions.has('run.create')) {
        throw forbidden('run.errors.cannotCreate');
      }
      if (command.sessionIds.length === 0) {
        throw validation('run.errors.noSessions');
      }
      if (command.plannedItems.length === 0) {
        throw validation('run.errors.noItems');
      }
      return [
        {
          ...baseFor(1),
          type: 'RunPlanned',
          payload: {
            orgId: command.orgId,
            runDate: command.runDate,
            runIndex: command.runIndex,
            sessionIds: command.sessionIds,
            plannedItems: command.plannedItems,
            purchaserMemberId: command.actor.memberId,
          },
        },
      ];
    }

    case 'StartPurchase':
      assertActive(state);
      // M3.33 (2026-05-18, Wave1 #11): perm check was missing — any
      // authed member able to reach this stream could transition the
      // run into purchasing. Now matches the perm gate on every other
      // purchaser action (PurchaseItem, MarkUnavailable, etc).
      if (!command.actor.permissions.has('run.purchase')) {
        throw forbidden('run.errors.cannotPurchase');
      }
      assertClaimOwnership(state, command.actor);
      if (state.status !== 'planned') {
        throw preconditionFailed('run.errors.cannotStartPurchase', { status: state.status });
      }
      return [{ ...baseFor(1), type: 'PurchaseStarted', payload: {} }];

    case 'PurchaseItem': {
      assertActive(state);
      if (!command.actor.permissions.has('run.purchase')) {
        throw forbidden('run.errors.cannotPurchase');
      }
      assertClaimOwnership(state, command.actor);
      // M3.33 (2026-05-18, Wave1 #12): block PurchaseItem in `delivering`
      // status too — before this fix the dispatcher could start delivery
      // while the purchaser kept recording buys, producing split rows
      // the dispatcher had no awareness of. `planned` is still allowed
      // because the command auto-emits PurchaseStarted (atomic first
      // buy on a fresh run).
      if (
        state.status !== 'planned' &&
        state.status !== 'purchasing' &&
        // 2026-07-30: `amending` was missing here while AddPurchaserItem
        // (which DOES allow it for `run.amend`) and RevisePurchase /
        // UndoPurchase / UnmarkUnavailable (via assertEditablePhase) all
        // allowed it. The gap: an item that is IN the run but was never
        // bought — typically one marked unavailable — can only be
        // recorded through PurchaseItem, and that threw runFrozen. The
        // obvious workaround was blocked too: re-adding the same SKU via
        // AddPurchaserItem refuses with alreadyInRun. So a super-admin
        // who reopened a finished run to record a buy they had missed
        // hit a wall with no path forward and no explanation beyond
        // "采购单已冻结". Same permission bar as the sibling commands.
        !(state.status === 'amending' && command.actor.permissions.has('run.amend'))
      ) {
        throw preconditionFailed('run.errors.runFrozen', { status: state.status });
      }
      const item = state.items.get(command.skuId);
      if (!item) throw validation('run.errors.itemNotInRun');
      // A second purchaser, or a stale offline replay, must not record
      // over a buy that is already on the books: the earlier splits and
      // price observation would silently stay behind in the read model.
      // Changing a recorded buy is RevisePurchase's job.
      if (item.status === 'purchased') {
        throw preconditionFailed('run.errors.itemAlreadyPurchased');
      }
      const actual = num(command.actualQty, 'run.errors.invalidQty');
      if (actual <= 0) throw validation('run.errors.qtyMustBePositive');
      const splitSum = command.storeSplits.reduce(
        (s, x) => s + num(x.qty, 'run.errors.invalidQty'),
        0,
      );
      if (Math.abs(splitSum - actual) > TOLERANCE) {
        throw validation('run.errors.splitSumMismatch', { actual, splitSum });
      }
      assertSplitOverrides(command.storeSplits);
      // 2026-10-21 audit CA-29: a split to a store outside the run sends
      // goods to a store that cannot see (or confirm) the run, which then
      // blocks FinishRun forever.
      if (command.runStoreIds) {
        assertStoresWithinRun(state, command.storeSplits, command.runStoreIds);
      }
      const events: RunEvent[] = [];
      if (state.status === 'planned') {
        events.push({ ...baseFor(events.length + 1), type: 'PurchaseStarted', payload: {} });
      }
      events.push({
        ...baseFor(events.length + 1),
        type: 'ItemPurchased',
        payload: {
          skuId: command.skuId,
          supplierId: command.supplierId,
          unitPrice: command.unitPrice,
          actualQty: command.actualQty,
          receiptPhotoUrl: command.receiptPhotoUrl,
          storeSplits: command.storeSplits,
          paymentMethod: command.paymentMethod,
          ...(command.priceConfirmed ? { priceConfirmed: true as const } : {}),
        },
      });
      return events;
    }

    case 'AddPurchaserItem': {
      // M3.41 (2026-05-21): purchaser-initiated mid-run addition.
      // Distinct from PurchaseItem (which targets a pre-planned row)
      // so reports can call out "X items added beyond the original
      // order, total Y" — see the rationale block at the event type
      // in events.ts.
      assertActive(state);
      if (!command.actor.permissions.has('run.purchase')) {
        throw forbidden('run.errors.cannotPurchase');
      }
      assertClaimOwnership(state, command.actor);
      // Same phase gate as PurchaseItem — adding mid-delivering would
      // race the store-split bake-in. After delivering, the operator
      // can still RevisePurchase existing rows, but creating new ones
      // is closed.
      if (
        state.status !== 'planned' &&
        state.status !== 'purchasing' &&
        // 2026-07-06: a super-admin amending a finished run may add a
        // missing item (records a correction, not a live purchase).
        !(state.status === 'amending' && command.actor.permissions.has('run.amend'))
      ) {
        throw preconditionFailed('run.errors.runFrozen', { status: state.status });
      }
      // No double-counting: if the SKU is already in the run (planned
      // or already-bought), force the operator down the existing
      // PurchaseItem / RevisePurchase path. Cleaner audit + no
      // ambiguity about whether the SKU was "ordered" or "added".
      if (state.items.has(command.skuId)) {
        throw preconditionFailed('run.errors.alreadyInRun', {
          skuId: command.skuId,
        });
      }
      const reason = command.reason.trim();
      if (!reason) throw validation('run.errors.addReasonRequired');
      if (reason.length > 500) throw validation('run.errors.noteTooLong');

      const actual = num(command.actualQty, 'run.errors.invalidQty');
      if (actual <= 0) throw validation('run.errors.qtyMustBePositive');
      const price = num(command.unitPrice, 'run.errors.invalidQty');
      if (price <= 0) throw validation('run.errors.qtyMustBePositive');

      const splitSum = command.storeSplits.reduce(
        (s, x) => s + num(x.qty, 'run.errors.invalidQty'),
        0,
      );
      if (Math.abs(splitSum - actual) > TOLERANCE) {
        throw validation('run.errors.splitSumMismatch', { actual, splitSum });
      }
      assertSplitOverrides(command.storeSplits);

      // Store-scope guard: every split's storeId must already be part
      // of THIS run's demand. Stretching the run to a brand-new store
      // mid-stream would require restructuring delivery splits — that
      // path is AttachSessions, not AddPurchaserItem. The set of
      // "involved stores" is derived from the existing items'
      // storeSplits AND the run-level stores map (so a run with only
      // pending items still has its store scope known).
      // 2026-10-21 audit CA-29: the derived set is empty on a run with
      // only pending items, so the API now passes the session-derived
      // `runStoreIds`; see assertStoresWithinRun.
      assertStoresWithinRun(state, command.storeSplits, command.runStoreIds);

      // Atomic emit: if the run is still in `planned`, also flip it to
      // `purchasing` (same auto-start convention PurchaseItem uses for
      // the "first buy on a fresh run" path).
      const events: RunEvent[] = [];
      if (state.status === 'planned') {
        events.push({ ...baseFor(events.length + 1), type: 'PurchaseStarted', payload: {} });
      }
      events.push({
        ...baseFor(events.length + 1),
        type: 'PurchaserItemAdded',
        payload: {
          skuId: command.skuId,
          supplierId: command.supplierId,
          unitPrice: command.unitPrice,
          actualQty: command.actualQty,
          receiptPhotoUrl: command.receiptPhotoUrl,
          storeSplits: command.storeSplits,
          paymentMethod: command.paymentMethod,
          reason,
          byMemberId: command.actor.memberId,
          ...(command.priceConfirmed ? { priceConfirmed: true as const } : {}),
        },
      });
      return events;
    }

    case 'AddRunExpense': {
      // M3.44 (2026-05-22): purchaser records an off-catalog expense.
      // Different lifecycle from PurchaseItem / AddPurchaserItem —
      // expenses aren't bound to a SKU, don't enter the planned-vs-
      // bought ledger, and never write to price_history. They also
      // ride through delivering (no per-store delivery/confirmation),
      // so the phase gate is wider: anything pre-terminal.
      assertActive(state);
      if (!command.actor.permissions.has('run.purchase')) {
        throw forbidden('run.errors.cannotPurchase');
      }
      assertClaimOwnership(state, command.actor);
      assertEditablePhase(state, command.actor);
      // Idempotent — replay of same expenseId is a no-op (the reducer
      // also detects this defensively but we short-circuit to avoid
      // writing a duplicate event).
      if (
        state.expenses.some((e) => e.id === command.expenseId) ||
        (state.removedExpenseIds ?? []).includes(command.expenseId)
      ) {
        return [];
      }
      const label = command.label.trim();
      if (!label) throw validation('run.errors.expenseLabelRequired');
      if (label.length > 200) throw validation('run.errors.expenseLabelTooLong');
      const reason = command.reason.trim();
      if (!reason) throw validation('run.errors.expenseReasonRequired');
      if (reason.length > 500) throw validation('run.errors.noteTooLong');
      const qty = num(command.qty, 'run.errors.invalidQty');
      if (qty <= 0) throw validation('run.errors.qtyMustBePositive');
      const price = num(command.unitPrice, 'run.errors.invalidQty');
      if (price <= 0) throw validation('run.errors.qtyMustBePositive');
      const splitSum = command.storeSplits.reduce(
        (s, x) => s + num(x.qty, 'run.errors.invalidQty'),
        0,
      );
      if (Math.abs(splitSum - qty) > TOLERANCE) {
        throw validation('run.errors.splitSumMismatch', { actual: qty, splitSum });
      }
      // Store-scope: every split storeId must already be part of this
      // run. Mirrors AddPurchaserItem's same guard.
      assertStoresWithinRun(state, command.storeSplits, command.runStoreIds);
      // 2026-07-06: removed the ">200,000 UZS requires a receipt photo"
      // gate. AddRunExpense already mandates a `reason` (checked above),
      // which is the actual audit trail; a paper receipt is often
      // unavailable at a bazaar, so blocking on it was the wrong
      // trade-off. The photo remains an optional attachment.
      return [
        {
          ...baseFor(1),
          type: 'RunExpenseAdded',
          payload: {
            expenseId: command.expenseId,
            label,
            unitHint: command.unitHint?.trim() || null,
            qty: command.qty,
            unitPrice: command.unitPrice,
            storeSplits: command.storeSplits,
            paymentMethod: command.paymentMethod,
            receiptPhotoUrl: command.receiptPhotoUrl,
            reason,
            byMemberId: command.actor.memberId,
          },
        },
      ];
    }

    case 'RemoveRunExpense': {
      assertActive(state);
      if (!command.actor.permissions.has('run.purchase')) {
        throw forbidden('run.errors.cannotPurchase');
      }
      assertClaimOwnership(state, command.actor);
      assertEditablePhase(state, command.actor);
      // Idempotent — removing what's already gone is a no-op.
      const target = state.expenses.find((e) => e.id === command.expenseId);
      if (!target) return [];
      const reason = command.reason.trim();
      if (reason.length > 500) throw validation('run.errors.noteTooLong');
      return [
        {
          ...baseFor(1),
          type: 'RunExpenseRemoved',
          payload: {
            expenseId: command.expenseId,
            reason,
            byMemberId: command.actor.memberId,
          },
        },
      ];
    }

    case 'MarkUnavailable': {
      assertActive(state);
      if (!command.actor.permissions.has('run.purchase')) {
        throw forbidden('run.errors.cannotPurchase');
      }
      assertClaimOwnership(state, command.actor);

      // Marking an item unavailable is a purchasing decision, not a generic
      // item-state toggle. In particular, a terminal run must not accept a
      // late ItemUnavailable event: that would change the settled ledger
      // without going through ReopenRun -> amendment -> RefinalizeRun.
      //
      // `planned` remains legal for backwards compatibility (just like the
      // first PurchaseItem can be recorded before StartPurchase). A reopened
      // run may use this command to correct "purchased" -> UndoPurchase ->
      // "unavailable", but the domain requires run.amend explicitly; the API
      // additionally proves that permission came from a persisted global
      // grant before invoking this decider for an amending stream.
      const inLivePurchasePhase = state.status === 'planned' || state.status === 'purchasing';
      const inAuthorizedAmendment =
        state.status === 'amending' && command.actor.permissions.has('run.amend');
      if (!inLivePurchasePhase && !inAuthorizedAmendment) {
        if (state.status === 'amending') {
          throw forbidden('run.errors.cannotAmend');
        }
        throw preconditionFailed('run.errors.runFrozen', { status: state.status });
      }

      const item = state.items.get(command.skuId);
      if (!item) throw validation('run.errors.itemNotInRun');
      if (item.status !== 'pending') {
        throw preconditionFailed('run.errors.itemNotPending', { status: item.status });
      }
      const note = command.note.trim();
      if (!note) throw validation('run.errors.unavailableNoteRequired');
      if (note.length > 500) throw validation('run.errors.noteTooLong');
      return [
        {
          ...baseFor(1),
          type: 'ItemUnavailable',
          payload: { skuId: command.skuId, note },
        },
      ];
    }

    case 'StartDelivery': {
      assertActive(state);
      // 2026-07-26: this transition had NO permission check at all.
      // The comment below says claim ownership gates it, but
      // assertClaimOwnership has an empty body (runs are deliberately
      // collaborative), so the only barrier was the tRPC layer's
      // assertRunStoreVisible — a STORE-SCOPE check, not a permission
      // one. Any member with a store in the run, including shop staff
      // whose entire permission set is order.draft / order.submit /
      // delivery.confirm / sales.record, could end the purchasing phase
      // while the purchaser was still standing in the market. After
      // that PurchaseItem rejects everything (it requires status
      // 'purchasing'), so the buy is frozen mid-trip.
      //
      // M3.33 Wave1 #11 fixed exactly this on StartPurchase and missed
      // its sibling; the gate below is the same one, deliberately, so
      // the pair reads identically. Every built-in role that can start
      // a delivery today (purchaser, admin, super_admin) holds
      // run.purchase, so no legitimate actor loses the transition.
      if (!command.actor.permissions.has('run.purchase')) {
        throw forbidden('run.errors.cannotPurchase');
      }
      // C.2 (M3.38): kept for symmetry with the other purchaser
      // transitions — currently a no-op by design (see the function).
      assertClaimOwnership(state, command.actor);
      if (state.status !== 'purchasing') {
        throw preconditionFailed('run.errors.notReadyToDeliver', { status: state.status });
      }
      const allHandled = Array.from(state.items.values()).every(
        (i) => i.status === 'purchased' || i.status === 'unavailable',
      );
      if (!allHandled) throw preconditionFailed('run.errors.itemsPending');
      return [{ ...baseFor(1), type: 'DeliveryStarted', payload: {} }];
    }

    case 'DeliverToStore': {
      assertActive(state);
      if (!command.actor.permissions.has('delivery.dispatch')) {
        throw forbidden('run.errors.cannotDispatch');
      }
      if (state.status !== 'delivering') {
        throw preconditionFailed('run.errors.notDelivering', { status: state.status });
      }
      // Already handed over: a retried request (offline replay, double
      // tap) is a no-op, not a second StoreDelivered and a second
      // notification to the store.
      if (state.stores.get(command.storeId)?.deliveredAt) return [];
      // 2026-10-21 audit CA-29: only a store the run serves can be handed
      // goods. Stores that hold a purchased split stay deliverable even if
      // they are outside `runStoreIds` (legacy runs), or the run could
      // never finish.
      {
        const allowed = new Set<string>(command.runStoreIds ?? []);
        for (const st of purchasedSplitStores(state)) allowed.add(st);
        for (const st of state.stores.keys()) allowed.add(st);
        if (!allowed.has(command.storeId)) {
          throw preconditionFailed('run.errors.storeNotInRun', { storeId: command.storeId });
        }
      }
      return [
        {
          ...baseFor(1),
          type: 'StoreDelivered',
          payload: { storeId: command.storeId, deliveredByUserId: command.actor.userId },
        },
      ];
    }

    case 'ConfirmStoreItem': {
      assertActive(state);
      if (!command.actor.permissions.has('delivery.confirm')) {
        throw forbidden('run.errors.cannotConfirm');
      }
      if (state.status !== 'delivering') {
        throw preconditionFailed('run.errors.notDelivering');
      }
      // 2026-10-21 audit CA-30: a store may only check goods that have
      // been handed over to it, only until it has signed for them (the
      // inventory receipt is written at StoreConfirmed and never revised),
      // and only for SKUs that were actually split to it.
      const target = state.stores.get(command.storeId);
      if (!target?.deliveredAt) {
        throw preconditionFailed('run.errors.storeNotDelivered');
      }
      if (target.confirmedAt) {
        throw preconditionFailed('run.errors.storeAlreadyConfirmed');
      }
      const confirmItem = state.items.get(command.skuId);
      const confirmSplit =
        confirmItem?.status === 'purchased'
          ? confirmItem.storeSplits.find((sp) => sp.storeId === command.storeId)
          : undefined;
      if (!confirmSplit) {
        throw validation('run.errors.itemNotInRun');
      }
      if (command.status !== 'ok') {
        const note = command.note?.trim() ?? '';
        if (!note) throw validation('run.errors.confirmNoteRequiredOnIssue');
      }
      // 2026-10-21 CA-06: a problem line records how much actually
      // arrived, and that — not the split qty — is what StoreConfirmed
      // books into inventory. 'short' must say how much; for a wrong or
      // spoiled item the safe default is that nothing usable arrived.
      let receivedQty: string | null = null;
      if (command.status !== 'ok') {
        const raw = command.receivedQty?.trim() ?? '';
        if (raw === '') {
          if (command.status === 'short') throw validation('run.errors.receivedQtyRequired');
          receivedQty = '0';
        } else {
          if (!/^\d+(\.\d+)?$/.test(raw)) {
            throw validation('run.errors.receivedQtyInvalid', { value: raw });
          }
          if (Number(raw) - Number(confirmSplit.qty) > TOLERANCE) {
            throw validation('run.errors.receivedQtyExceedsSplit', { max: confirmSplit.qty });
          }
          receivedQty = raw;
        }
      }
      // Dedupe — if the item is already at exactly the requested status
      // (and same note + photo), don't append another event. Without
      // this guard, double-tap on the "ok" chip — common when the round
      // trip is slow and the user assumes the first tap missed —
      // produced multiple StoreItemConfirmed rows in the audit log,
      // bloating the event count and making the confirm-store
      // precondition harder to reason about. The user reported tapping
      // confirm "but status didn't change" and the log showed 4–5
      // identical events for the same SKU.
      const existingStore = state.stores.get(command.storeId);
      const existing = existingStore?.itemConfirms.get(command.skuId);
      const newNote = command.note?.trim() || null;
      if (
        existing &&
        existing.status === command.status &&
        (existing.note ?? null) === newNote &&
        (existing.photoUrl ?? null) === (command.photoUrl ?? null) &&
        (existing.receivedQty ?? null) === receivedQty
      ) {
        return [];
      }
      return [
        {
          ...baseFor(1),
          type: 'StoreItemConfirmed',
          payload: {
            storeId: command.storeId,
            skuId: command.skuId,
            status: command.status,
            note: newNote,
            photoUrl: command.photoUrl,
            // Omitted (not null) on 'ok' so those events keep their
            // pre-CA-06 shape byte for byte.
            ...(receivedQty !== null ? { receivedQty } : {}),
          },
        },
      ];
    }

    case 'ConfirmStore': {
      assertActive(state);
      if (!command.actor.permissions.has('delivery.confirm')) {
        throw forbidden('run.errors.cannotConfirm');
      }
      // A delivery may only be accepted while the run is actively in its
      // delivery phase. In particular, a store that was delivered before a
      // later cancellation must not be able to confirm the cancelled run and
      // trigger the inventory-receipt projection afterwards.
      if (state.status !== 'delivering') {
        throw preconditionFailed('run.errors.notDelivering', { status: state.status });
      }
      const store = state.stores.get(command.storeId);
      if (!store?.deliveredAt) {
        throw preconditionFailed('run.errors.storeNotDelivered');
      }
      // Dedupe — if the store has already been confirmed, return [] so
      // the second tap is a no-op. Without this, the user reported
      // tapping "Confirm store" 5 times before the UI feedback caught
      // up (slow ws round-trip), each tap appended another
      // StoreConfirmed event, polluting the audit log and confusing
      // the run-level finish guard.
      if (store.confirmedAt) return [];
      // Every item that was supposed to land at this store needs a confirm.
      const expected = new Set<string>();
      for (const item of state.items.values()) {
        if (item.status !== 'purchased') continue;
        for (const split of item.storeSplits) {
          if (split.storeId === command.storeId) expected.add(item.skuId);
        }
      }
      const events: RunEvent[] = [];
      for (const skuId of expected) {
        if (!store.itemConfirms.has(skuId)) {
          events.push({
            ...baseFor(events.length + 1),
            type: 'StoreItemConfirmed',
            payload: {
              storeId: command.storeId,
              skuId,
              status: 'ok',
              note: null,
              photoUrl: null,
            },
          });
        }
      }
      events.push({
        ...baseFor(events.length + 1),
        type: 'StoreConfirmed',
        payload: { storeId: command.storeId, confirmedByUserId: command.actor.userId },
      });
      return events;
    }

    case 'FinishRun': {
      assertActive(state);
      if (!command.actor.permissions.has('run.finish')) {
        throw forbidden('run.errors.cannotFinish');
      }
      assertClaimOwnership(state, command.actor);
      if (state.status !== 'delivering') {
        throw preconditionFailed('run.errors.notFinishable', { status: state.status });
      }
      // Every store touched by purchased items must be confirmed.
      const involvedStores = new Set<string>();
      for (const item of state.items.values()) {
        if (item.status !== 'purchased') continue;
        for (const split of item.storeSplits) involvedStores.add(split.storeId);
      }
      for (const storeId of involvedStores) {
        if (!state.stores.get(storeId)?.confirmedAt) {
          throw preconditionFailed('run.errors.storeNotConfirmed', { storeId });
        }
      }
      // M1.14: cash / transfer breakdown alongside the canonical total.
      // Shared with RefinalizeRun so a post-finish amendment re-freezes
      // totals by the exact same math (cash + transfer = total holds).
      const { total, totalCash, totalTransfer, expensesTotal } = computeRunTotals(state);
      return [
        {
          ...baseFor(1),
          type: 'RunFinished',
          payload: {
            totalActual: total.toFixed(2),
            totalCash: totalCash.toFixed(2),
            totalTransfer: totalTransfer.toFixed(2),
            itemsTotal: total.toFixed(2),
            expensesTotal: expensesTotal.toFixed(2),
          },
        },
      ];
    }

    case 'CancelRun': {
      assertActive(state);
      if (state.status === 'finished') throw preconditionFailed('run.errors.alreadyFinished');
      // `amending` is a finished run under correction; `cancelled` is
      // already terminal. Neither has anything left to cancel.
      if (state.status === 'cancelled' || state.status === 'amending') {
        throw preconditionFailed('run.errors.runFrozen', { status: state.status });
      }
      if (!command.actor.permissions.has('run.create')) {
        throw forbidden('run.errors.cannotCancel');
      }
      // A confirmed store has taken the goods into stock. Cancelling
      // would hand its sessions back as `approved`, to be bought and
      // received a second time, with nothing reversing the first receipt.
      for (const store of state.stores.values()) {
        if (store.confirmedAt) throw preconditionFailed('run.errors.cannotCancelAfterConfirm');
      }
      // M1.7 (2026-05-07): reason is OPTIONAL by user request — most
      // cancels are misclicks; hard-requiring a reason produces "asdf"
      // noise that pollutes audit. The FE shows an encouraging
      // placeholder but doesn't gate submit. Audit captures the cancel
      // either way (event + policy_decisions row); empty-reason cancels
      // are still attributable to actor + timestamp.
      const reason = command.reason.trim();
      return [
        {
          ...baseFor(1),
          type: 'RunCancelled',
          payload: { reason: reason || null },
        },
      ];
    }

    // ---- Post-finish amendment (2026-07-06, super-admin) -------------
    case 'ReopenRun': {
      if (state.status === 'absent') throw preconditionFailed('run.errors.streamMissing');
      if (!command.actor.permissions.has('run.amend')) {
        throw forbidden('run.errors.cannotAmend');
      }
      // Only a FINISHED run can be reopened. Cancelled is permanently
      // frozen; in-flight runs are edited normally, no reopen needed.
      if (state.status !== 'finished') {
        throw preconditionFailed('run.errors.notReopenable', { status: state.status });
      }
      const reason = command.reason.trim();
      if (!reason) throw validation('run.errors.reopenReasonRequired');
      if (reason.length > 500) throw validation('run.errors.noteTooLong');
      return [
        {
          ...baseFor(1),
          type: 'RunReopened',
          payload: { reason, byMemberId: command.actor.memberId },
        },
      ];
    }

    case 'ChangeRunDate': {
      if (state.status === 'absent') throw preconditionFailed('run.errors.streamMissing');
      if (!command.actor.permissions.has('run.amend')) {
        throw forbidden('run.errors.cannotAmend');
      }
      // Cancelled runs stay frozen, exactly as they are for every other
      // edit. Every other phase is fair game — unlike the item-level
      // commands this does NOT require a reopen first, because the whole
      // point is correcting a finished run's date, and forcing
      // reopen → change → refinalize would rewrite the run's totals as a
      // side effect of a pure calendar fix.
      if (state.status === 'cancelled') {
        throw preconditionFailed('run.errors.runFrozen', { status: state.status });
      }
      const runDate = command.runDate.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate)) {
        throw validation('run.errors.invalidRunDate');
      }
      // Reject a date the calendar doesn't have (2026-02-31 parses to
      // March 3 via Date's rollover, which would silently book the spend
      // in the wrong month).
      const parsed = new Date(`${runDate}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== runDate) {
        throw validation('run.errors.invalidRunDate');
      }
      // No-op guard: emitting an event that changes nothing would add an
      // audit entry claiming a correction happened.
      if (state.runDate === runDate) {
        throw preconditionFailed('run.errors.runDateUnchanged');
      }
      return [
        {
          ...baseFor(1),
          type: 'RunDateChanged',
          payload: {
            runDate,
            previousRunDate: state.runDate,
            ...(command.runIndex !== undefined ? { runIndex: command.runIndex } : {}),
            byMemberId: command.actor.memberId,
          },
        },
      ];
    }

    case 'RefinalizeRun': {
      if (state.status === 'absent') throw preconditionFailed('run.errors.streamMissing');
      if (!command.actor.permissions.has('run.amend')) {
        throw forbidden('run.errors.cannotAmend');
      }
      if (state.status !== 'amending') {
        throw preconditionFailed('run.errors.notRefinalizable', { status: state.status });
      }
      // Recompute totals from the amended state (same math as FinishRun)
      // so the read model's frozen totals are correct again.
      const { total, totalCash, totalTransfer, expensesTotal } = computeRunTotals(state);
      return [
        {
          ...baseFor(1),
          type: 'RunRefinalized',
          payload: {
            totalActual: total.toFixed(2),
            totalCash: totalCash.toFixed(2),
            totalTransfer: totalTransfer.toFixed(2),
            itemsTotal: total.toFixed(2),
            expensesTotal: expensesTotal.toFixed(2),
            byMemberId: command.actor.memberId,
          },
        },
      ];
    }

    // ---- Reversal commands -------------------------------------------
    case 'RevisePurchase': {
      assertActive(state);
      if (!command.actor.permissions.has('run.purchase')) {
        throw forbidden('run.errors.cannotPurchase');
      }
      assertClaimOwnership(state, command.actor);
      assertEditablePhase(state, command.actor);
      const item = state.items.get(command.skuId);
      if (!item) throw validation('run.errors.itemNotInRun');
      // Only revise an already-purchased item. Pending / unavailable
      // items have nothing to revise — use PurchaseItem / Unmark first.
      if (item.status !== 'purchased') {
        throw preconditionFailed('run.errors.notRevisable', { status: item.status });
      }
      // Once a destination store has accepted delivery, the splits going
      // to that store are baked into the world; revising them would be
      // misleading. Block revision if any of this SKU's stores have
      // already been delivered.
      // Skipped while `amending`: a super-admin correcting a closed run
      // may fix records for goods that were already delivered/confirmed
      // (the physical receipt stands; the recorded numbers are what's
      // being corrected). Outside amending the guard holds as before.
      if (state.status !== 'amending') {
        for (const split of item.storeSplits) {
          const store = state.stores.get(split.storeId);
          if (store?.deliveredAt) {
            throw preconditionFailed('run.errors.cannotReviseAfterDelivery', {
              storeId: split.storeId,
            });
          }
        }
      }
      const actual = num(command.actualQty, 'run.errors.invalidQty');
      if (actual <= 0) throw validation('run.errors.qtyMustBePositive');
      const splitSum = command.storeSplits.reduce(
        (s, x) => s + num(x.qty, 'run.errors.invalidQty'),
        0,
      );
      if (Math.abs(splitSum - actual) > TOLERANCE) {
        throw validation('run.errors.splitSumMismatch', { actual, splitSum });
      }
      assertSplitOverrides(command.storeSplits);
      // 2026-10-21 audit CA-29: same store-scope guard as PurchaseItem.
      if (command.runStoreIds) {
        assertStoresWithinRun(state, command.storeSplits, command.runStoreIds);
      }
      const reason = command.reason.trim();
      if (!reason) throw validation('run.errors.reviseReasonRequired');
      if (reason.length > 500) throw validation('run.errors.noteTooLong');
      return [
        {
          ...baseFor(1),
          type: 'PurchaseRevised',
          payload: {
            skuId: command.skuId,
            supplierId: command.supplierId,
            unitPrice: command.unitPrice,
            actualQty: command.actualQty,
            receiptPhotoUrl: command.receiptPhotoUrl,
            storeSplits: command.storeSplits,
            reason,
            paymentMethod: command.paymentMethod,
            ...(command.priceConfirmed ? { priceConfirmed: true as const } : {}),
          },
        },
      ];
    }

    case 'UndoPurchase': {
      assertActive(state);
      if (!command.actor.permissions.has('run.purchase')) {
        throw forbidden('run.errors.cannotPurchase');
      }
      assertClaimOwnership(state, command.actor);
      assertEditablePhase(state, command.actor);
      const item = state.items.get(command.skuId);
      if (!item) throw validation('run.errors.itemNotInRun');
      if (item.status !== 'purchased') {
        throw preconditionFailed('run.errors.notPurchased', { status: item.status });
      }
      // Same rule as RevisePurchase: once goods have been delivered
      // to ANY destination store the purchase is "real" and can't be
      // un-recorded; revising the audit log to claim it never happened
      // would be misleading.
      // Skipped while `amending`: a super-admin correcting a closed run
      // may fix records for goods that were already delivered/confirmed
      // (the physical receipt stands; the recorded numbers are what's
      // being corrected). Outside amending the guard holds as before.
      if (state.status !== 'amending') {
        for (const split of item.storeSplits) {
          const store = state.stores.get(split.storeId);
          if (store?.deliveredAt) {
            throw preconditionFailed('run.errors.cannotReviseAfterDelivery', {
              storeId: split.storeId,
            });
          }
        }
      }
      // Reason was demoted to optional 2026-05-04 — see UndoPurchaseInputSchema
      // for the full rationale. The event still fires (projector needs it
      // to flip the row back to `pending`), but `reason` is just an empty
      // string when the operator didn't bother typing one.
      const reason = (command.reason ?? '').trim();
      if (reason.length > 500) throw validation('run.errors.noteTooLong');
      return [{ ...baseFor(1), type: 'PurchaseUndone', payload: { skuId: command.skuId, reason } }];
    }

    case 'UnmarkUnavailable': {
      assertActive(state);
      if (!command.actor.permissions.has('run.purchase')) {
        throw forbidden('run.errors.cannotPurchase');
      }
      assertClaimOwnership(state, command.actor);
      assertEditablePhase(state, command.actor);
      const item = state.items.get(command.skuId);
      if (!item) throw validation('run.errors.itemNotInRun');
      if (item.status !== 'unavailable') {
        throw preconditionFailed('run.errors.notUnavailable', { status: item.status });
      }
      const reason = command.reason.trim();
      if (!reason) throw validation('run.errors.unmarkReasonRequired');
      if (reason.length > 500) throw validation('run.errors.noteTooLong');
      return [
        { ...baseFor(1), type: 'UnavailableUndone', payload: { skuId: command.skuId, reason } },
      ];
    }

    case 'UndeliverStore': {
      assertActive(state);
      if (!command.actor.permissions.has('delivery.dispatch')) {
        throw forbidden('run.errors.cannotDispatch');
      }
      if (state.status !== 'delivering') {
        throw preconditionFailed('run.errors.notDelivering', { status: state.status });
      }
      const store = state.stores.get(command.storeId);
      if (!store?.deliveredAt) {
        throw preconditionFailed('run.errors.storeNotDelivered');
      }
      // Once the store has confirmed receipt, we can't take it back —
      // they've physically accepted the goods. The recall window is
      // strictly between `deliver` and `confirm`.
      if (store.confirmedAt) {
        throw preconditionFailed('run.errors.alreadyConfirmed');
      }
      const reason = command.reason.trim();
      if (!reason) throw validation('run.errors.recallReasonRequired');
      if (reason.length > 500) throw validation('run.errors.noteTooLong');
      return [
        {
          ...baseFor(1),
          type: 'StoreDeliveryUndone',
          payload: { storeId: command.storeId, reason },
        },
      ];
    }

    case 'AttachSessions': {
      assertActive(state);
      if (
        !command.actor.permissions.has('run.create') &&
        !command.actor.permissions.has('run.create.org')
      ) {
        throw forbidden('run.errors.cannotPlan');
      }
      if (state.status !== 'planned' && state.status !== 'purchasing') {
        throw preconditionFailed('run.errors.cannotAttachInStatus', {
          status: state.status,
        });
      }
      if (command.sessionIds.length === 0) {
        throw validation('run.errors.noSessionsToAttach');
      }
      // Reject sessions already in this run — duplicate attach would
      // double-count their demand. The API layer already filters,
      // but this is the defense-in-depth.
      const existing = new Set(state.sessionIds);
      for (const sid of command.sessionIds) {
        if (existing.has(sid)) {
          throw preconditionFailed('run.errors.sessionAlreadyInRun', {
            sessionId: sid,
          });
        }
      }
      return [
        {
          ...baseFor(1),
          type: 'SessionsAttachedToRun',
          payload: {
            sessionIds: command.sessionIds,
            addedPlannedItems: command.addedPlannedItems,
          },
        },
      ];
    }

    case 'EjectSession': {
      assertActive(state);
      if (!command.actor.permissions.has('run.eject_session')) {
        throw forbidden('run.errors.cannotEjectSession');
      }
      if (state.status !== 'planned' && state.status !== 'purchasing') {
        throw preconditionFailed('run.errors.cannotEjectInStatus', {
          status: state.status,
        });
      }
      if (!state.sessionIds.includes(command.sessionId)) {
        throw preconditionFailed('run.errors.sessionNotInRun', {
          sessionId: command.sessionId,
        });
      }
      if (state.sessionIds.length <= 1) {
        throw preconditionFailed('run.errors.cannotEjectLastSession');
      }
      const items = new Map(state.items);
      for (const removed of command.removedPlannedItems) {
        const qty = num(removed.qty, 'run.errors.invalidQty');
        if (qty <= 0) throw validation('run.errors.qtyMustBePositive');
        const existing = items.get(removed.skuId);
        if (!existing) continue;
        if (existing.status !== 'pending') {
          throw preconditionFailed('order.errors.cannotEject', {
            skuId: removed.skuId,
            status: existing.status,
          });
        }
        const planned = num(existing.plannedQty, 'run.errors.invalidQty');
        if (qty - planned > TOLERANCE) {
          throw preconditionFailed('run.errors.ejectQtyExceedsPlan', {
            skuId: removed.skuId,
            planned,
            qty,
          });
        }
        const remaining = planned - qty;
        if (remaining <= TOLERANCE) {
          items.delete(removed.skuId);
        } else {
          items.set(removed.skuId, { ...existing, plannedQty: remaining.toString() });
        }
      }
      if (items.size === 0) {
        throw preconditionFailed('run.errors.cannotEjectLastSession');
      }

      const reason = (command.reason ?? '').trim();
      if (reason.length > 500) throw validation('run.errors.noteTooLong');
      return [
        {
          ...baseFor(1),
          type: 'SessionEjectedFromRun',
          payload: {
            sessionId: command.sessionId,
            removedPlannedItems: command.removedPlannedItems,
            reason: reason || null,
            byMemberId: command.actor.memberId,
          },
        },
      ];
    }

    case 'UndoStartPurchase': {
      assertActive(state);
      if (!command.actor.permissions.has('run.purchase')) {
        throw forbidden('run.errors.cannotPurchase');
      }
      assertClaimOwnership(state, command.actor);
      if (state.status !== 'purchasing') {
        throw preconditionFailed('run.errors.notPurchasing', { status: state.status });
      }
      // M3.29 (2026-05-18): previously this command was gated on every
      // item still being `pending` — any single purchase/unavailable
      // mark blocked the revert. User feedback: "I want to step back
      // to plan to modify the run without losing the buys I already
      // recorded". The PurchaseStartUndone reducer + projector only
      // touch `status` + `started_at` (state.ts:260, runProjection.ts:377);
      // item-level purchase data already round-trips cleanly. Lifting
      // the gate exposes that already-correct behavior.
      const reason = command.reason.trim();
      if (!reason) throw validation('run.errors.undoReasonRequired');
      if (reason.length > 500) throw validation('run.errors.noteTooLong');
      return [{ ...baseFor(1), type: 'PurchaseStartUndone', payload: { reason } }];
    }

    case 'UndoStartDelivery': {
      assertActive(state);
      if (!command.actor.permissions.has('delivery.dispatch')) {
        throw forbidden('run.errors.cannotDispatch');
      }
      assertClaimOwnership(state, command.actor);
      if (state.status !== 'delivering') {
        throw preconditionFailed('run.errors.notDelivering', { status: state.status });
      }
      // Allowed only if no store has been delivered to yet.
      for (const store of state.stores.values()) {
        if (store.deliveredAt) {
          throw preconditionFailed('run.errors.deliveryAlreadyProgressed');
        }
      }
      const reason = command.reason.trim();
      if (!reason) throw validation('run.errors.undoReasonRequired');
      if (reason.length > 500) throw validation('run.errors.noteTooLong');
      return [{ ...baseFor(1), type: 'DeliveryStartUndone', payload: { reason } }];
    }

    case 'ClaimRun': {
      // C.2 (M3.38): a purchaser claims the run so other purchasers
      // can't write conflicting events. Allowed during the active
      // window (planned/purchasing/delivering). Terminal states have
      // no claim concept.
      assertActive(state);
      if (!command.actor.permissions.has('run.purchase')) {
        throw forbidden('run.errors.cannotPurchase');
      }
      if (
        state.status !== 'planned' &&
        state.status !== 'purchasing' &&
        state.status !== 'delivering'
      ) {
        throw preconditionFailed('run.errors.notClaimable', { status: state.status });
      }
      if (state.claimedByMemberId === command.actor.memberId) {
        return []; // already mine — idempotent
      }
      if (state.claimedByMemberId) {
        throw conflict('run.errors.claimedByOther', {
          claimedBy: state.claimedByMemberId,
        });
      }
      return [
        {
          ...baseFor(1),
          type: 'RunClaimed',
          payload: { byMemberId: command.actor.memberId },
        },
      ];
    }

    case 'ReleaseRunClaim': {
      // C.2 (M3.38): release the claim. Self-releases pass through
      // with the supplied reason. If the actor is NOT the claimer,
      // this is a take-over — same command but re-tagged as
      // 'override'. Override requires `run.purchase` (same gate as
      // claim) so we don't need a separate permission check.
      assertActive(state);
      if (!state.claimedByMemberId) return [];
      const isSelf = state.claimedByMemberId === command.actor.memberId;
      if (!isSelf && !command.actor.permissions.has('run.purchase')) {
        throw forbidden('run.errors.cannotPurchase');
      }
      return [
        {
          ...baseFor(1),
          type: 'RunClaimReleased',
          payload: {
            byMemberId: command.actor.memberId,
            reason: isSelf ? command.reason : 'override',
          },
        },
      ];
    }

    default: {
      const _x: never = command;
      void _x;
      return [];
    }
  }
}

function assertActive(state: RunState): void {
  if (state.status === 'absent') throw preconditionFailed('run.errors.streamMissing');
}

/**
 * Run-level money, computed from the current state. Extracted from
 * FinishRun so RefinalizeRun re-freezes by identical math.
 *
 * `total` / `totalCash` / `totalTransfer` are ITEMS ONLY (every purchased
 * SKU line at COALESCE(split override, item price)) — the long-standing
 * meaning of `actual_total`; cash + transfer = total by construction.
 *
 * 2026-10-21 CA-11: `expensesTotal` is the sum of active off-catalog
 * expenses, emitted alongside so the one purchase-money definition —
 * items + expenses, always shown as items / expenses / total — is on the
 * event itself. Exported for the domain tests.
 */
export function computeRunTotals(state: RunState): {
  total: number;
  totalCash: number;
  totalTransfer: number;
  expensesTotal: number;
} {
  let total = 0;
  let totalCash = 0;
  let totalTransfer = 0;
  for (const item of state.items.values()) {
    if (item.status !== 'purchased' || !item.unitPrice || !item.purchasedQty) continue;
    const hasSplitOverrides = item.storeSplits.some(
      (split) => split.unitPrice !== undefined || split.paymentMethod !== undefined,
    );
    if (hasSplitOverrides) {
      for (const split of item.storeSplits) {
        const lineTotal = Number(split.unitPrice ?? item.unitPrice) * Number(split.qty);
        total += lineTotal;
        if ((split.paymentMethod ?? item.paymentMethod) === 'transfer') totalTransfer += lineTotal;
        else totalCash += lineTotal;
      }
    } else {
      const lineTotal = Number(item.unitPrice) * Number(item.purchasedQty);
      total += lineTotal;
      if (item.paymentMethod === 'transfer') totalTransfer += lineTotal;
      else totalCash += lineTotal;
    }
  }
  let expensesTotal = 0;
  for (const expense of state.expenses) {
    const line = Number(expense.qty) * Number(expense.unitPrice);
    if (Number.isFinite(line)) expensesTotal += line;
  }
  return { total, totalCash, totalTransfer, expensesTotal };
}

/**
 * Post-finish amendment gate (2026-07-06). A finished run reopened to
 * `amending` unlocks the normal edit commands, but ONLY for actors
 * holding `run.amend` (super-admin). Everyone else still hits the frozen
 * wall. Cancelled stays permanently frozen. Returns nothing; throws the
 * appropriate precondition/forbidden on a blocked edit.
 */
function assertEditablePhase(state: RunState, actor: ActorCtx): void {
  if (state.status === 'cancelled') {
    throw preconditionFailed('run.errors.runFrozen', { status: state.status });
  }
  if (state.status === 'finished') {
    // Finished runs are frozen; a super-admin must ReopenRun first.
    throw preconditionFailed('run.errors.runFrozen', { status: state.status });
  }
  if (state.status === 'amending' && !actor.permissions.has('run.amend')) {
    throw forbidden('run.errors.cannotAmend');
  }
}

/**
 * Runs are intentionally collaborative. Concurrent purchasers can record
 * independent rows or expenses; event-stream serialization protects the
 * ledger from stale writes and each event still records its actor.
 */
function assertClaimOwnership(_state: RunState, _actor: ActorCtx): void {
  // Runs are collaborative: separate purchasers may record separate
  // SKU rows or expenses concurrently. Event-stream serialization and
  // per-event actor auditing still protect the ledger from stale writes.
}

/**
 * 2026-10-21 audit CA-29: every split must target a store the run serves.
 *
 * The domain state only learns stores from purchased splits and delivery
 * records, so on a run with nothing bought yet that derived set is empty
 * and any storeId used to slip through. The API therefore passes
 * `runStoreIds` (the stores of the run's order sessions), which is the
 * authoritative scope; stores that already hold a delivery record stay
 * allowed so a legacy run can still be corrected. Without `runStoreIds`
 * the old derived-set check applies (empty set → no check).
 */
function assertStoresWithinRun(
  state: RunState,
  splits: ReadonlyArray<{ storeId: string }>,
  runStoreIds: readonly string[] | undefined,
): void {
  const allowed = new Set<string>(runStoreIds ?? []);
  if (!runStoreIds) {
    for (const it of state.items.values()) {
      for (const sp of it.storeSplits) allowed.add(sp.storeId);
    }
  }
  for (const st of state.stores.keys()) allowed.add(st);
  if (!runStoreIds && allowed.size === 0) return;
  for (const sp of splits) {
    if (!allowed.has(sp.storeId)) {
      throw preconditionFailed('run.errors.storeNotInRun', { storeId: sp.storeId });
    }
  }
}

function purchasedSplitStores(state: RunState): Set<string> {
  const out = new Set<string>();
  for (const item of state.items.values()) {
    if (item.status !== 'purchased') continue;
    for (const sp of item.storeSplits) out.add(sp.storeId);
  }
  return out;
}

function assertSplitOverrides(splits: StoreSplitCommand[]): void {
  for (const split of splits) {
    if (split.unitPrice !== undefined) {
      const price = num(split.unitPrice, 'run.errors.invalidQty');
      if (price <= 0) throw validation('run.errors.qtyMustBePositive');
    }
  }
}

function num(s: string, errorKey: string): number {
  const v = Number(s);
  if (!Number.isFinite(v)) throw validation(errorKey, { value: s });
  return v;
}
