/**
 * Delivery (review RUNAPI-13): starting it once every line is handled,
 * handing the goods to a store, the store checking and signing for them,
 * and taking a hand-over or the start back.
 */
import { forbidden, preconditionFailed, validation } from '../../shared/errors';
import type { RunEvent, StoreSplitPayload } from '../events';
import type { RunState, RunStoreDeliveryState } from '../state';
import { assertActive, topUpOf, TOLERANCE, type ActorCtx, type EventBase } from './guards';

export type DeliveryCommand =
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
  | {
      /**
       * The receiver's "all arrived" at one store (run.markStoreItemsOk,
       * review RUNAPI-13): every listed product the store has not checked
       * yet is confirmed 'ok', one StoreItemConfirmed each. A product it
       * has already checked, either way, is left as it is.
       */
      type: 'ConfirmStoreItemsOk';
      storeId: string;
      skuIds: readonly string[];
      actor: ActorCtx;
    }
  | { type: 'ConfirmStore'; storeId: string; actor: ActorCtx }
  | { type: 'UndeliverStore'; storeId: string; reason: string; actor: ActorCtx }
  | { type: 'UndoStartDelivery'; reason: string; actor: ActorCtx };

export function decideDelivery(
  state: RunState,
  command: DeliveryCommand,
  baseFor: EventBase,
): RunEvent[] {
  switch (command.type) {
    case 'StartDelivery': {
      assertActive(state);
      // 2026-07-26: this transition had NO permission check at all.
      // A run claim gates nothing (runs are deliberately collaborative:
      // concurrent purchasers record their own rows, the event stream
      // serialises them), so the only barrier was the tRPC layer's
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
      if (state.status !== 'purchasing') {
        throw preconditionFailed('run.errors.notReadyToDeliver', { status: state.status });
      }
      const allHandled = Array.from(state.items.values()).every(
        (i) => i.status === 'purchased' || i.status === 'unavailable',
      );
      if (!allHandled) throw preconditionFailed('run.errors.itemsPending');
      // BUY-5 (2026-10-30): an order joined after an item was bought (or
      // marked unavailable) and asked for more of it. Buy the difference or
      // say it will not be bought before the goods go out.
      if (Array.from(state.items.values()).some((i) => topUpOf(i) > 0)) {
        throw preconditionFailed('run.errors.topUpPending');
      }
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
      const target = receivingStore(state, command);
      const confirmSplit = receivedSplit(state, command.storeId, command.skuId);
      // Simplification C2 (2026-11-13): a wrong or spoiled item needs a
      // note; a short line says what is wrong through receivedQty, so its
      // note is optional.
      if (command.status === 'wrong' || command.status === 'quality') {
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
          // DLV-12 (2026-10-30): "short" with the whole split arrived is
          // a contradiction the screen already refuses — it is "ok".
          if (command.status === 'short' && Number(confirmSplit.qty) - Number(raw) <= TOLERANCE) {
            throw validation('run.errors.receivedQtyNotShort', { max: confirmSplit.qty });
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
      const existing = target.itemConfirms.get(command.skuId);
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

    case 'ConfirmStoreItemsOk': {
      // The same checks as ConfirmStoreItem, made even when every listed
      // product has been checked already: the router's copy of this loop
      // skipped them then and answered success.
      const target = receivingStore(state, command);
      const events: RunEvent[] = [];
      for (const skuId of new Set(command.skuIds)) {
        receivedSplit(state, command.storeId, skuId);
        if (target.itemConfirms.has(skuId)) continue;
        events.push({
          ...baseFor(events.length + 1),
          type: 'StoreItemConfirmed',
          payload: { storeId: command.storeId, skuId, status: 'ok', note: null, photoUrl: null },
        });
      }
      return events;
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
      // Every item that was supposed to land at this store needs a
      // verdict first. DLV-19 (2026-10-30): this used to write "ok" for
      // each line nobody had checked, indistinguishable from a real
      // check; the screens only offer the button once every line is
      // decided ("mark all OK" is its own command, markStoreItemsOk).
      let unchecked = 0;
      for (const item of state.items.values()) {
        if (item.status !== 'purchased') continue;
        for (const split of item.storeSplits) {
          if (split.storeId === command.storeId && !store.itemConfirms.has(item.skuId)) {
            unchecked += 1;
          }
        }
      }
      if (unchecked > 0) {
        throw preconditionFailed('run.errors.storeItemsUnchecked', { n: unchecked });
      }
      return [
        {
          ...baseFor(1),
          type: 'StoreConfirmed',
          payload: { storeId: command.storeId, confirmedByUserId: command.actor.userId },
        },
      ];
    }

    // ---- Reversal commands -------------------------------------------
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

/**
 * The store whose goods `command` checks, once the actor may and the run
 * is out for delivery. 2026-10-21 audit CA-30: only goods handed over to
 * the store, and only until it has signed for them (the inventory receipt
 * is written at StoreConfirmed and never revised).
 */
function receivingStore(
  state: RunState,
  command: { storeId: string; actor: ActorCtx },
): RunStoreDeliveryState {
  assertActive(state);
  if (!command.actor.permissions.has('delivery.confirm')) {
    throw forbidden('run.errors.cannotConfirm');
  }
  if (state.status !== 'delivering') {
    throw preconditionFailed('run.errors.notDelivering');
  }
  const store = state.stores.get(command.storeId);
  if (!store?.deliveredAt) {
    throw preconditionFailed('run.errors.storeNotDelivered');
  }
  if (store.confirmedAt) {
    throw preconditionFailed('run.errors.storeAlreadyConfirmed');
  }
  return store;
}

/** The store's split of a product bought for it: the only products it checks (CA-30). */
function receivedSplit(state: RunState, storeId: string, skuId: string): StoreSplitPayload {
  const item = state.items.get(skuId);
  const split =
    item?.status === 'purchased'
      ? item.storeSplits.find((sp) => sp.storeId === storeId)
      : undefined;
  if (!split) throw validation('run.errors.itemNotInRun');
  return split;
}

function purchasedSplitStores(state: RunState): Set<string> {
  const out = new Set<string>();
  for (const item of state.items.values()) {
    if (item.status !== 'purchased') continue;
    for (const sp of item.storeSplits) out.add(sp.storeId);
  }
  return out;
}
