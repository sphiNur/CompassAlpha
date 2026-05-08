import { conflict, forbidden, preconditionFailed, validation } from '../shared/errors';
import type { Clock } from '../shared/clock';
import { systemClock } from '../shared/clock';
import type { RunEvent } from './events';
import type { RunState } from './state';

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
      storeSplits: Array<{ storeId: string; qty: string }>;
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
      storeSplits: Array<{ storeId: string; qty: string }>;
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
  | { type: 'UndoStartDelivery'; reason: string; actor: ActorCtx };

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
      if (state.status !== 'planned') {
        throw preconditionFailed('run.errors.cannotStartPurchase', { status: state.status });
      }
      return [{ ...baseFor(1), type: 'PurchaseStarted', payload: {} }];

    case 'PurchaseItem': {
      assertActive(state);
      if (!command.actor.permissions.has('run.purchase')) {
        throw forbidden('run.errors.cannotPurchase');
      }
      if (state.status === 'finished' || state.status === 'cancelled') {
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

    case 'MarkUnavailable': {
      assertActive(state);
      if (!command.actor.permissions.has('run.purchase')) {
        throw forbidden('run.errors.cannotPurchase');
      }
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
      for (const skuId of expected) {
        if (!store.itemConfirms.has(skuId)) {
          throw preconditionFailed('run.errors.itemConfirmMissing', { skuId });
        }
      }
      return [
        {
          ...baseFor(1),
          type: 'StoreConfirmed',
          payload: { storeId: command.storeId, confirmedByUserId: command.actor.userId },
        },
      ];
    }

    case 'FinishRun': {
      assertActive(state);
      if (!command.actor.permissions.has('run.finish')) {
        throw forbidden('run.errors.cannotFinish');
      }
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
        const lineTotal = Number(item.unitPrice) * Number(item.purchasedQty);
        total += lineTotal;
        if (item.paymentMethod === 'transfer') totalTransfer += lineTotal;
        else totalCash += lineTotal;
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

    case 'UndoStartPurchase': {
      assertActive(state);
      if (!command.actor.permissions.has('run.purchase')) {
        throw forbidden('run.errors.cannotPurchase');
      }
      if (state.status !== 'purchasing') {
        throw preconditionFailed('run.errors.notPurchasing', { status: state.status });
      }
      // Allowed only if NOTHING real has happened yet — every item must
      // still be pending. If anyone has bought or marked anything we
      // refuse the undo (use revise / unmark first).
      for (const item of state.items.values()) {
        if (item.status !== 'pending') {
          throw preconditionFailed('run.errors.purchaseAlreadyProgressed');
        }
      }
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

function num(s: string, errorKey: string): number {
  const v = Number(s);
  if (!Number.isFinite(v)) throw validation(errorKey, { value: s });
  return v;
}
