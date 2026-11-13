/**
 * Purchasing (review RUNAPI-13): starting it and taking it back, buying,
 * revising and undoing a line, marking one unavailable, the top-up, the
 * run's off-catalog expenses and the run-level claim. A super-admin
 * corrects a reopened run (`amending`) with these commands too.
 */
import { conflict, forbidden, preconditionFailed, validation } from '../../shared/errors';
import type { RunEvent } from '../events';
import type { RunState } from '../state';
import {
  assertActive,
  assertEditablePhase,
  assertLineCap,
  assertListOpen,
  assertSplitOverrides,
  assertStoresWithinRun,
  num,
  topUpOf,
  TOLERANCE,
  type ActorCtx,
  type EventBase,
  type StoreSplitCommand,
} from './guards';

export type PurchasingCommand =
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
  /** Simplification 2026-11-13: the reason is optional (was required). */
  | { type: 'UnmarkUnavailable'; skuId: string; reason?: string; actor: ActorCtx }
  /** BUY-5: the purchaser decides not to buy the extra demand that
   *  arrived after this item was already bought or marked unavailable. */
  | { type: 'DismissTopUp'; skuId: string; note?: string; actor: ActorCtx }
  | { type: 'UndoPurchase'; skuId: string; reason?: string; actor: ActorCtx }
  | { type: 'UndoStartPurchase'; reason?: string; actor: ActorCtx }
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

export function decidePurchasing(
  state: RunState,
  command: PurchasingCommand,
  baseFor: EventBase,
): RunEvent[] {
  switch (command.type) {
    case 'StartPurchase':
      assertActive(state);
      // M3.33 (2026-05-18, Wave1 #11): perm check was missing — any
      // authed member able to reach this stream could transition the
      // run into purchasing. Now matches the perm gate on every other
      // purchaser action (PurchaseItem, MarkUnavailable, etc).
      if (!command.actor.permissions.has('run.purchase')) {
        throw forbidden('run.errors.cannotPurchase');
      }
      if (state.status !== 'planned') {
        throw preconditionFailed('run.errors.cannotStartPurchase', { status: state.status });
      }
      return [{ ...baseFor(1), type: 'PurchaseStarted', payload: {} }];

    case 'PurchaseItem': {
      assertActive(state);
      if (!command.actor.permissions.has('run.purchase')) {
        throw forbidden('run.errors.cannotPurchase');
      }
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
      assertLineCap(command.unitPrice, command.actualQty, command.storeSplits);
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
      // RUNAPI-19: a bad price says so; it read "quantity must be positive".
      const price = num(command.unitPrice, 'run.errors.priceFormat');
      if (price <= 0) throw validation('run.errors.priceFormat');

      const splitSum = command.storeSplits.reduce(
        (s, x) => s + num(x.qty, 'run.errors.invalidQty'),
        0,
      );
      if (Math.abs(splitSum - actual) > TOLERANCE) {
        throw validation('run.errors.splitSumMismatch', { actual, splitSum });
      }
      assertSplitOverrides(command.storeSplits);
      assertLineCap(command.unitPrice, command.actualQty, command.storeSplits);

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
      // RUNAPI-19: a bad price says so; it read "quantity must be positive".
      const price = num(command.unitPrice, 'run.errors.priceFormat');
      if (price <= 0) throw validation('run.errors.priceFormat');
      const splitSum = command.storeSplits.reduce(
        (s, x) => s + num(x.qty, 'run.errors.invalidQty'),
        0,
      );
      if (Math.abs(splitSum - qty) > TOLERANCE) {
        throw validation('run.errors.splitSumMismatch', { actual: qty, splitSum });
      }
      assertLineCap(command.unitPrice, command.qty, []);
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

    // ---- Reversal commands -------------------------------------------
    case 'RevisePurchase': {
      assertActive(state);
      if (!command.actor.permissions.has('run.purchase')) {
        throw forbidden('run.errors.cannotPurchase');
      }
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
      // 2026-10-30 (owner decision): prices are often filled in after the
      // goods went out. Once a store has the goods, its quantity and split
      // stand, but price, supplier, payment method and receipt may still
      // be corrected until the run is finished.
      // 2026-11-09 (review RUNAPI-01): the NEW splits count too. Moving
      // part of a line onto a store that already has its goods left that
      // store unable to receive it (its receipt is closed, so the stock
      // never came in) while the cost and the amend note landed on it.
      if (state.status !== 'amending') {
        const deliveredSplit = [...item.storeSplits, ...command.storeSplits].find(
          (split) => !!state.stores.get(split.storeId)?.deliveredAt,
        );
        if (deliveredSplit && !sameQuantities(item, command.actualQty, command.storeSplits)) {
          throw preconditionFailed('run.errors.cannotReviseAfterDelivery', {
            storeId: deliveredSplit.storeId,
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
      assertLineCap(command.unitPrice, command.actualQty, command.storeSplits);
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
      assertListOpen(state);
      // Reason was demoted to optional 2026-05-04 — see UndoPurchaseInputSchema
      // for the full rationale. The event still fires (projector needs it
      // to flip the row back to `pending`), but `reason` is just an empty
      // string when the operator didn't bother typing one.
      const reason = (command.reason ?? '').trim();
      if (reason.length > 500) throw validation('run.errors.noteTooLong');
      return [{ ...baseFor(1), type: 'PurchaseUndone', payload: { skuId: command.skuId, reason } }];
    }

    case 'DismissTopUp': {
      assertActive(state);
      if (!command.actor.permissions.has('run.purchase')) {
        throw forbidden('run.errors.cannotPurchase');
      }
      assertEditablePhase(state, command.actor);
      const item = state.items.get(command.skuId);
      if (!item) throw validation('run.errors.itemNotInRun');
      if (!(topUpOf(item) > 0)) return [];
      const note = (command.note ?? '').trim();
      if (note.length > 500) throw validation('run.errors.noteTooLong');
      return [
        {
          ...baseFor(1),
          type: 'TopUpDismissed',
          payload: { skuId: command.skuId, qty: item.topUpQty!, note },
        },
      ];
    }

    case 'UnmarkUnavailable': {
      assertActive(state);
      if (!command.actor.permissions.has('run.purchase')) {
        throw forbidden('run.errors.cannotPurchase');
      }
      assertEditablePhase(state, command.actor);
      const item = state.items.get(command.skuId);
      if (!item) throw validation('run.errors.itemNotInRun');
      if (item.status !== 'unavailable') {
        throw preconditionFailed('run.errors.notUnavailable', { status: item.status });
      }
      assertListOpen(state);
      // Simplification (2026-11-13): the reason is optional; marking the
      // item unavailable again undoes this. An empty one is recorded as ''.
      const reason = (command.reason ?? '').trim();
      if (reason.length > 500) throw validation('run.errors.noteTooLong');
      return [
        { ...baseFor(1), type: 'UnavailableUndone', payload: { skuId: command.skuId, reason } },
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
      // M3.29 (2026-05-18): previously this command was gated on every
      // item still being `pending` — any single purchase/unavailable
      // mark blocked the revert. User feedback: "I want to step back
      // to plan to modify the run without losing the buys I already
      // recorded". The PurchaseStartUndone reducer + projector only
      // touch `status` + `started_at` (state.ts:260, runProjection.ts:377);
      // item-level purchase data already round-trips cleanly. Lifting
      // the gate exposes that already-correct behavior.
      // Simplification (2026-11-13): the reason is optional; Start
      // purchase undoes this. An empty one is recorded as ''.
      const reason = (command.reason ?? '').trim();
      if (reason.length > 500) throw validation('run.errors.noteTooLong');
      return [{ ...baseFor(1), type: 'PurchaseStartUndone', payload: { reason } }];
    }

    case 'ClaimRun': {
      // C.2 (M3.38): a purchaser marks the run as theirs. Nothing checks
      // the claim since runs became collaborative (review RUNAPI-17); no
      // client sends this any more (run.claim is deprecated). Allowed
      // during the active window (planned/purchasing/delivering).
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

/** Same total and the same quantity per store (prices may differ). */
function sameQuantities(
  item: { purchasedQty: string | null; storeSplits: Array<{ storeId: string; qty: string }> },
  actualQty: string,
  splits: Array<{ storeId: string; qty: string }>,
): boolean {
  if (Math.abs(Number(item.purchasedQty ?? 0) - Number(actualQty)) > TOLERANCE) return false;
  const before = new Map<string, number>();
  for (const sp of item.storeSplits)
    before.set(sp.storeId, (before.get(sp.storeId) ?? 0) + Number(sp.qty));
  const after = new Map<string, number>();
  for (const sp of splits) after.set(sp.storeId, (after.get(sp.storeId) ?? 0) + Number(sp.qty));
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    if (Math.abs((before.get(id) ?? 0) - (after.get(id) ?? 0)) > TOLERANCE) return false;
  }
  return true;
}
