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
      actor: ActorCtx;
    }
  | { type: 'MarkUnavailable'; skuId: string; note: string; actor: ActorCtx }
  | { type: 'StartDelivery'; actor: ActorCtx }
  | { type: 'DeliverToStore'; storeId: string; actor: ActorCtx }
  | {
      type: 'ConfirmStoreItem';
      storeId: string;
      skuId: string;
      status: 'ok' | 'short' | 'wrong' | 'quality';
      note: string | null;
      photoUrl: string | null;
      actor: ActorCtx;
    }
  | { type: 'ConfirmStore'; storeId: string; actor: ActorCtx }
  | { type: 'FinishRun'; actor: ActorCtx }
  | { type: 'CancelRun'; reason: string; actor: ActorCtx }
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

export function decideRun(state: RunState, command: RunCommand, clock: Clock = systemClock): RunEvent[] {
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
      if (state.status !== 'planned' && state.status !== 'purchasing') {
        throw preconditionFailed('run.errors.runFrozen', { status: state.status });
      }
      const item = state.items.get(command.skuId);
      if (!item) throw validation('run.errors.itemNotInRun');
      const actual = num(command.actualQty, 'run.errors.invalidQty');
      if (actual <= 0) throw validation('run.errors.qtyMustBePositive');
      const splitSum = command.storeSplits.reduce((s, x) => s + num(x.qty, 'run.errors.invalidQty'), 0);
      if (Math.abs(splitSum - actual) > TOLERANCE) {
        throw validation('run.errors.splitSumMismatch', { actual, splitSum });
      }
      assertSplitOverrides(command.storeSplits);
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
      if (state.status !== 'planned' && state.status !== 'purchasing') {
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
      const involvedStores = new Set<string>();
      for (const it of state.items.values()) {
        for (const sp of it.storeSplits) involvedStores.add(sp.storeId);
      }
      for (const st of state.stores.keys()) involvedStores.add(st);
      // If the items + stores maps are both empty (theoretical), fall
      // back to letting any storeId through — but PlanRun guards
      // against empty items, so this branch should be unreachable in
      // practice.
      if (involvedStores.size > 0) {
        for (const sp of command.storeSplits) {
          if (!involvedStores.has(sp.storeId)) {
            throw preconditionFailed('run.errors.storeNotInRun', {
              storeId: sp.storeId,
            });
          }
        }
      }

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
      if (state.status === 'finished' || state.status === 'cancelled') {
        throw preconditionFailed('run.errors.runFrozen', { status: state.status });
      }
      // Idempotent — replay of same expenseId is a no-op (the reducer
      // also detects this defensively but we short-circuit to avoid
      // writing a duplicate event).
      if (state.expenses.some((e) => e.id === command.expenseId)) {
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
      const involvedStores = new Set<string>();
      for (const it of state.items.values()) {
        for (const sp of it.storeSplits) involvedStores.add(sp.storeId);
      }
      for (const st of state.stores.keys()) involvedStores.add(st);
      if (involvedStores.size > 0) {
        for (const sp of command.storeSplits) {
          if (!involvedStores.has(sp.storeId)) {
            throw preconditionFailed('run.errors.storeNotInRun', {
              storeId: sp.storeId,
            });
          }
        }
      }
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
      if (state.status === 'finished' || state.status === 'cancelled') {
        throw preconditionFailed('run.errors.runFrozen', { status: state.status });
      }
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
      const note = command.note.trim();
      if (!note) throw validation('run.errors.unavailableNoteRequired');
      if (note.length > 500) throw validation('run.errors.noteTooLong');
      const item = state.items.get(command.skuId);
      if (!item) throw validation('run.errors.itemNotInRun');
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
      // C.2 (M3.38): StartDelivery is the purchaser's "I'm done buying"
      // transition. Gate it with claim ownership so a second purchaser
      // doesn't flip the run forward while the first is still recording.
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
      if (command.status !== 'ok') {
        const note = command.note?.trim() ?? '';
        if (!note) throw validation('run.errors.confirmNoteRequiredOnIssue');
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
        (existing.photoUrl ?? null) === (command.photoUrl ?? null)
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
          },
        },
      ];
    }

    case 'ConfirmStore': {
      assertActive(state);
      if (!command.actor.permissions.has('delivery.confirm')) {
        throw forbidden('run.errors.cannotConfirm');
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
      // M1.14: compute cash / transfer breakdown alongside the canonical
      // total. Items with no payment method recorded (legacy data
      // pre-M1.14) are bucketed as cash — that's the historical
      // assumption since transfers weren't tracked at all before.
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
            if ((split.paymentMethod ?? item.paymentMethod) === 'transfer') {
              totalTransfer += lineTotal;
            } else {
              totalCash += lineTotal;
            }
          }
        } else {
          const lineTotal = Number(item.unitPrice) * Number(item.purchasedQty);
          total += lineTotal;
          if (item.paymentMethod === 'transfer') totalTransfer += lineTotal;
          else totalCash += lineTotal;
        }
      }
      return [
        {
          ...baseFor(1),
          type: 'RunFinished',
          payload: {
            totalActual: total.toFixed(2),
            totalCash: totalCash.toFixed(2),
            totalTransfer: totalTransfer.toFixed(2),
          },
        },
      ];
    }

    case 'CancelRun': {
      assertActive(state);
      if (state.status === 'finished') throw preconditionFailed('run.errors.alreadyFinished');
      if (!command.actor.permissions.has('run.create')) {
        throw forbidden('run.errors.cannotCancel');
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

    // ---- Reversal commands -------------------------------------------
    case 'RevisePurchase': {
      assertActive(state);
      if (!command.actor.permissions.has('run.purchase')) {
        throw forbidden('run.errors.cannotPurchase');
      }
      assertClaimOwnership(state, command.actor);
      if (state.status === 'finished' || state.status === 'cancelled') {
        throw preconditionFailed('run.errors.runFrozen', { status: state.status });
      }
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
      for (const split of item.storeSplits) {
        const store = state.stores.get(split.storeId);
        if (store?.deliveredAt) {
          throw preconditionFailed('run.errors.cannotReviseAfterDelivery', {
            storeId: split.storeId,
          });
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
      if (state.status === 'finished' || state.status === 'cancelled') {
        throw preconditionFailed('run.errors.runFrozen', { status: state.status });
      }
      const item = state.items.get(command.skuId);
      if (!item) throw validation('run.errors.itemNotInRun');
      if (item.status !== 'purchased') {
        throw preconditionFailed('run.errors.notPurchased', { status: item.status });
      }
      // Same rule as RevisePurchase: once goods have been delivered
      // to ANY destination store the purchase is "real" and can't be
      // un-recorded; revising the audit log to claim it never happened
      // would be misleading.
      for (const split of item.storeSplits) {
        const store = state.stores.get(split.storeId);
        if (store?.deliveredAt) {
          throw preconditionFailed('run.errors.cannotReviseAfterDelivery', {
            storeId: split.storeId,
          });
        }
      }
      // Reason was demoted to optional 2026-05-04 — see UndoPurchaseInputSchema
      // for the full rationale. The event still fires (projector needs it
      // to flip the row back to `pending`), but `reason` is just an empty
      // string when the operator didn't bother typing one.
      const reason = (command.reason ?? '').trim();
      if (reason.length > 500) throw validation('run.errors.noteTooLong');
      return [
        { ...baseFor(1), type: 'PurchaseUndone', payload: { skuId: command.skuId, reason } },
      ];
    }

    case 'UnmarkUnavailable': {
      assertActive(state);
      if (!command.actor.permissions.has('run.purchase')) {
        throw forbidden('run.errors.cannotPurchase');
      }
      assertClaimOwnership(state, command.actor);
      if (state.status === 'finished' || state.status === 'cancelled') {
        throw preconditionFailed('run.errors.runFrozen', { status: state.status });
      }
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
        { ...baseFor(1), type: 'StoreDeliveryUndone', payload: { storeId: command.storeId, reason } },
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
 * Runs are intentionally collaborative. Concurrent purchasers can record
 * independent rows or expenses; event-stream serialization protects the
 * ledger from stale writes and each event still records its actor.
 */
function assertClaimOwnership(_state: RunState, _actor: ActorCtx): void {
  // Runs are collaborative: separate purchasers may record separate
  // SKU rows or expenses concurrently. Event-stream serialization and
  // per-event actor auditing still protect the ledger from stale writes.
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
