/**
 * Planning a run: creating it from the approved orders, attaching more,
 * taking one out, and cancelling the run.
 */
import { TRPCError } from '@trpc/server';
import { randomUUID } from 'node:crypto';
import {
  EjectSessionInputSchema,
  RunAttachSessionsInputSchema,
  RunCancelInputSchema,
  RunCreateInputSchema,
  milliQty,
  qtyMilli,
} from '@compass/contracts';
import {
  assertActorAssignedToStore,
  effectivePermissionsForStore,
  resolveRunCreateStoreScope,
} from '../../../services/storeScope';
import { applyRun, decideRun, emptyRunState, type RunEvent } from '@compass/domain/run';
import { decide as decideOrder, type OrderEvent } from '@compass/domain/order';
import { DomainError } from '@compass/domain';
import { authedProcedure, idempotentMutation, rethrowDomainError } from '../../trpc';
import { isUniqueViolation } from '../../../services/pgErrors';
import { loadRunState } from '../../../services/runStream';
import { loadOrderState } from '../../../services/orderStream';
import { writeOrderEvents, writeRunEvents } from '../../../services/streamWrite';
import { hub } from '../../../realtime/hub';
import { dispatchRunEventNotifications } from '../../../services/notifyForEvent';
import { orgToday } from '../../../services/timeZone';
import {
  actorFromCtx,
  orderActorFromCtx,
  attachSessionsToRun,
  isRunSlotConflict,
  runCreateRetryable,
  withRunStreamRetry,
  loadRun,
} from './command';
import {
  assertStoreIdsWithinRunCreateScope,
  assertRunCreateScopeForRun,
  assertCanAmendRun,
  assertRunPermissionForAllStores,
} from './scope';

export const planProcedures = {
  /**
   * Plan a run from approved sessions on a given date.
   *
   * Scope (M3.2): two modes, mirroring `previewCreatable`:
   *
   *   - org-tier actor (`run.create.org` or `users.manage`):
   *     can include sessions from ANY store in the org. This is
   *     the head-purchaser path — one buyer walks the bazaar for
   *     the whole chain.
   *
   *   - store-tier actor (purchaser bound to specific stores):
   *     every session in `input.sessionIds` MUST belong to a store
   *     the actor is bound to. If even one session is outside their
   *     scope the entire create is rejected — partial runs would be
   *     surprising. The check is precise: an attacker who guessed
   *     a Store B session UUID gets `auth.errors.notAssignedToStore`
   *     instead of silently slipping into the run.
   */
  // M1.20: idempotent — FE sends X-Idempotency-Key per logical
  // "create run" action so network retry doesn't create two runs.
  create: idempotentMutation.input(RunCreateInputSchema).mutation(async ({ ctx, input }) => {
    // BUY-12 (2026-10-30): a double tap raced on the orders' streams and
    // answered 500; decided again, the second finds the run the first made.
    // RUNAPI-04: the same for a race on the run's own unique indexes.
    return withRunStreamRetry(
      ctx,
      async (tx) => {
        const today = orgToday(ctx.session);
        const date = input.date ?? today;

        /**
         * One non-terminal run per org (migration 0035, 2026-07-26).
         *
         * Return the live run instead of failing. This procedure is about
         * to be called implicitly — Q7(a) drops the explicit "new run"
         * button and creates the run on the purchaser's first recorded
         * action — so "there is already one" is the normal case, not an
         * error. Making it idempotent here means the caller can just ask
         * for a run id and get the right one.
         *
         * Sessions are deliberately NOT attached to the returned run.
         * Anything still plannable while a run is open belongs to
         * run.attachSessions, which has its own guards for the run's
         * status; quietly folding that into create would make one
         * procedure mean two things.
         *
         * 2026-10-21 CA-04: only a planned/purchasing run is "the live
         * run" now (migration 0047 narrowed the unique index to match). A
         * run that is out for delivery no longer blocks a new trip — it
         * used to, and one store that never confirmed froze purchasing for
         * the whole organisation.
         */
        const live = await tx.query.marketRunsV.findFirst({
          where: (r, { eq: eq2, and: and2, inArray: inArray2 }) =>
            and2(eq2(r.orgId, ctx.session!.orgId), inArray2(r.status, ['planned', 'purchasing'])),
        });
        if (live) {
          // Returning an existing live run is still a run.create operation.
          // A Store-A purchaser must not learn/reuse a Store-B-only run merely
          // because a store-scoped custom role leaked `run.create.org` into the
          // flat session union.
          await assertRunCreateScopeForRun(tx, ctx, live);
          return { runId: live.id, runIndex: live.runIndex, lastSeq: live.lastSeq, reused: true };
        }

        // Determine next runIndex for the day (re-runs produce runIndex=1, 2, ...).
        const existing = await tx.query.marketRunsV.findMany({
          where: (r, { eq: eq2, and: and2 }) =>
            and2(eq2(r.orgId, ctx.session!.orgId), eq2(r.runDate, date)),
          orderBy: (r, { desc }) => desc(r.runIndex),
        });
        const runIndex = existing.length === 0 ? 0 : existing[0]!.runIndex + 1;

        // Verify sessions exist, are approved, and aren't already in a run.
        const sessions = await tx.query.orderSessionsV.findMany({
          where: (sess, { eq: eq2, and: and2, inArray: inArray2 }) =>
            and2(eq2(sess.orgId, ctx.session!.orgId), inArray2(sess.id, input.sessionIds)),
        });
        if (sessions.length !== input.sessionIds.length) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'run.errors.sessionMissing' });
        }
        for (const sess of sessions) {
          if (sess.status !== 'approved') {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'run.errors.sessionNotApproved',
            });
          }
        }
        // A global preview/create scope must come from a persisted GLOBAL
        // `run.create.org` grant. Otherwise resolve `run.create` at each
        // concrete store, so Store-A purchaser + Store-B staff membership
        // cannot combine into Store-B planning authority.
        const allowedStoreIds = await resolveRunCreateStoreScope(tx, ctx.session!);
        assertStoreIdsWithinRunCreateScope(
          sessions.map((session) => session.storeId),
          allowedStoreIds,
        );

        // 2026-10-21 CA-03: the purchaser may book the run under an earlier
        // date (yesterday's orders bought this morning), but never a date
        // the calendar doesn't have (2026-02-31 would roll into March) or
        // one in the future (org timezone). Checked after the store-scope
        // gate so an out-of-scope request reports the permission problem.
        {
          const parsed = new Date(`${date}T00:00:00Z`);
          if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'run.errors.invalidRunDate' });
          }
          if (date > today) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'run.errors.runDateInFuture' });
          }
        }

        // Aggregate items across sessions.
        const items = await tx.query.orderItemsV.findMany({
          where: (it, { inArray: inArray2 }) => inArray2(it.sessionId, input.sessionIds),
        });
        // RUNAPI-05: in whole thousandths; the strings go into RunPlanned.
        const aggregated = new Map<string, bigint>();
        for (const it of items) {
          const qty = qtyMilli(it.qty);
          if (qty <= 0n) continue;
          aggregated.set(it.skuId, (aggregated.get(it.skuId) ?? 0n) + qty);
        }
        const plannedItems = [...aggregated.entries()].map(([skuId, qty]) => ({
          skuId,
          qty: milliQty(qty),
        }));

        const runId = randomUUID();
        const state = emptyRunState(runId);
        let events: RunEvent[] = [];
        try {
          events = decideRun(state, {
            type: 'PlanRun',
            orgId: ctx.session!.orgId,
            runDate: date,
            runIndex,
            sessionIds: input.sessionIds,
            plannedItems,
            actor: actorFromCtx(ctx),
          });
          // M1.13 (2026-05-08): atomic plan + start. The FE collapsed
          // the "+ New run" / "Start purchase" double-tap. Fold the
          // PlanRun events forward, then ask the aggregate to emit
          // StartPurchase against that fresh state. Both event sets
          // commit in the same DB transaction below — projection lag
          // never sees a half-state. Single-step callers (older clients
          // and tests) still get the original two-event flow.
          if (input.startImmediately) {
            const startEvents = decideRun(events.reduce(applyRun, state), {
              type: 'StartPurchase',
              actor: actorFromCtx(ctx),
            });
            events = events.concat(startEvents);
          }
        } catch (err) {
          if (err instanceof DomainError) rethrowDomainError(err);
          throw err;
        }

        // 2026-06-08: templates are manual shortcuts, not automatic
        // daily costs. Real extra expenses vary by business date and
        // store, so a new run must not silently inherit template rows.

        try {
          // 2026-07-26: the projection (in writeRunEvents) moved INSIDE the
          // try. It is where market_runs_v is actually inserted, so it is
          // where both unique constraints can fire — (org, date, index) if
          // two callers computed the same next index, and the new
          // one-active-per-org index if another caller created a run
          // between this one's `live` check above and this insert. Outside
          // the try, either surfaced as a 500.
          //
          // The transaction is aborted by then, so it cannot re-read to
          // find the winner. RUNAPI-04 (2026-11-09): the error goes out as
          // it is, and withRunStreamRetry runs the whole transaction again;
          // the next attempt hits the `live` short-circuit and returns the
          // run that won.
          await writeRunEvents(tx, ctx.session!.orgId, state, events);
        } catch (err) {
          if (isRunSlotConflict(err)) throw err;
          if (isUniqueViolation(err)) {
            throw new TRPCError({ code: 'CONFLICT', message: 'run.errors.alreadyPlanned' });
          }
          throw err;
        }

        // Emit AttachedToRun on each session stream.
        const attachedSessions = await attachSessionsToRun(tx, ctx, runId, input.sessionIds);

        // 2026-07-26: run.create was the only run mutation that broadcast
        // nothing — compare attachSessions / ejectSession / purchaseItem,
        // which all publish here. Two visible consequences:
        //
        //   - a second purchaser's client had no idea a run existed until
        //     its next 6s poll;
        //   - the store staff whose approved orders this call just LOCKED
        //     (AttachToRun makes them uneditable and un-unapprovable) got
        //     no order.changed at all, so their Order/Approval screens
        //     kept offering actions the server would now reject.
        //
        // Deliberately NOT calling dispatchRunEventNotifications here:
        // that sends real Telegram messages, and "should creating a run
        // notify everyone" is a product decision, not a missing-broadcast
        // bug. Left for whoever wants that behaviour to choose it.
        hub.publish(ctx.session!.orgId, {
          type: 'run.changed',
          orgId: ctx.session!.orgId,
          runId,
          lastSeq: events[events.length - 1]?.seq ?? 0,
        });
        for (const a of attachedSessions) {
          hub.publish(ctx.session!.orgId, {
            type: 'order.changed',
            orgId: ctx.session!.orgId,
            sessionId: a.sessionId,
            lastSeq: a.lastSeq,
          });
        }

        return {
          runId,
          runIndex,
          lastSeq: events[events.length - 1]?.seq ?? 0,
          reused: false,
        };
      },
      runCreateRetryable,
    );
  }),

  /**
   * M3.31 A.2 (2026-05-18): attach additional approved sessions to a
   * live run. Allowed while the run is `planned` or `purchasing`.
   *
   * The mutation mirrors `create` in shape — aggregate the new sessions'
   * orderItemsV rows into a delta, emit `SessionsAttachedToRun` on the
   * run stream, then `AttachedToRun` on each session stream so the
   * session transitions from `approved` to `in_run` and stops appearing
   * in `previewCreatable`. Store-scope guard runs on every new session
   * (same as `create`) — a store-tier purchaser can only attach
   * sessions from stores they're bound to.
   */
  attachSessions: idempotentMutation
    .input(RunAttachSessionsInputSchema)
    .mutation(async ({ ctx, input }) => {
      return withRunStreamRetry(ctx, async (tx) => {
        const run = await loadRun(tx, ctx.session!.orgId, input.runId);
        await assertRunCreateScopeForRun(tx, ctx, run);
        if (run.status === 'amending') await assertCanAmendRun(tx, ctx, run);
        if (run.status !== 'planned' && run.status !== 'purchasing') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'run.errors.cannotAttachInStatus',
          });
        }
        const alreadyIn = new Set(run.sessionIdsJson);
        const dedupedNewIds = input.sessionIds.filter((id) => !alreadyIn.has(id));
        if (dedupedNewIds.length === 0) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'run.errors.allSessionsAlreadyInRun',
          });
        }
        const sessions = await tx.query.orderSessionsV.findMany({
          where: (sess, { eq: eq2, and: and2, inArray: inArray2 }) =>
            and2(eq2(sess.orgId, ctx.session!.orgId), inArray2(sess.id, dedupedNewIds)),
        });
        if (sessions.length !== dedupedNewIds.length) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'run.errors.sessionMissing' });
        }
        for (const sess of sessions) {
          if (sess.status !== 'approved') {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'run.errors.sessionNotApproved',
            });
          }
        }
        const allowedStoreIds = await resolveRunCreateStoreScope(tx, ctx.session!);
        assertStoreIdsWithinRunCreateScope(
          sessions.map((session) => session.storeId),
          allowedStoreIds,
        );

        // Aggregate items across the new sessions only — these become
        // the delta. The run state reducer merges them on top of
        // whatever's already planned.
        const items = await tx.query.orderItemsV.findMany({
          where: (it, { inArray: inArray2 }) => inArray2(it.sessionId, dedupedNewIds),
        });
        // RUNAPI-05: in whole thousandths, as in run.create.
        const aggregated = new Map<string, bigint>();
        for (const it of items) {
          const qty = qtyMilli(it.qty);
          if (qty <= 0n) continue;
          aggregated.set(it.skuId, (aggregated.get(it.skuId) ?? 0n) + qty);
        }
        const addedPlannedItems = [...aggregated.entries()].map(([skuId, qty]) => ({
          skuId,
          qty: milliQty(qty),
        }));

        // Replay the run aggregate, then decide AttachSessions.
        const runState = await loadRunState(tx, run.id);
        let producedEvents: RunEvent[];
        try {
          producedEvents = decideRun(runState, {
            type: 'AttachSessions',
            sessionIds: dedupedNewIds,
            addedPlannedItems,
            actor: actorFromCtx(ctx),
          });
        } catch (err) {
          if (err instanceof DomainError) rethrowDomainError(err);
          throw err;
        }
        await writeRunEvents(tx, ctx.session!.orgId, runState, producedEvents);

        // Move each attached session's stream from approved → in_run.
        const attachedSessions = await attachSessionsToRun(tx, ctx, run.id, dedupedNewIds);

        // 2026-10-21 audit CA-31: same broadcast as `create` — without it
        // other purchasers' Run page and the attached sessions' Order /
        // Approval screens stayed stale and kept offering actions the
        // server now rejects. (Notifications stay off, as in `create`.)
        const runLastSeq = producedEvents[producedEvents.length - 1]?.seq ?? runState.seq;
        hub.publish(ctx.session!.orgId, {
          type: 'run.changed',
          orgId: ctx.session!.orgId,
          runId: run.id,
          lastSeq: runLastSeq,
        });
        for (const a of attachedSessions) {
          hub.publish(ctx.session!.orgId, {
            type: 'order.changed',
            orgId: ctx.session!.orgId,
            sessionId: a.sessionId,
            lastSeq: a.lastSeq,
          });
        }

        return {
          runId: run.id,
          attached: dedupedNewIds,
          lastSeq: producedEvents[producedEvents.length - 1]?.seq ?? runState.seq,
        };
      });
    }),

  /**
   * Cancel the entire run. Cascading effect:
   *
   *   1. RunCancelled on the run stream (status → cancelled)
   *   2. EjectedFromRun on EVERY attached session stream (status → approved,
   *      runId → null) so those sessions become available for the next
   *      run instead of being stuck at `in_run` forever.
   *
   * Without step 2 (the bug the user hit on 2026-05-03): cancelling a run
   * left the user's order page showing "Submitted · in run" with no way to
   * progress, the approval page filtered out non-submitted statuses, and
   * the run page filtered out cancelled runs — so the order disappeared
   * from every screen and could never be re-planned.
   *
   * Items already marked Purchased / Unavailable on the run stream remain
   * in the audit log (event sourcing is append-only). Goods physically
   * delivered before cancel stay where they are; cancelling does not undo
   * physical reality. The receiving stores can flag any issues via the
   * normal confirm/issue flow against the next run.
   */
  // 2026-07-26: was RunReasonOnlyInputSchema (`reason: min(1)`), which
  // rejected the empty reason the FE deliberately sends — every
  // no-reason cancel died as BAD_REQUEST behind a generic error toast.
  // The domain has allowed an empty reason since M1.7; only the edge
  // schema disagreed. See RunCancelInputSchema for why the shared
  // schema was NOT relaxed instead.
  cancel: authedProcedure.input(RunCancelInputSchema).mutation(async ({ ctx, input }) => {
    return withRunStreamRetry(ctx, async (tx) => {
      const run = await loadRun(tx, ctx.session!.orgId, input.runId);
      let runState = await loadRunState(tx, run.id);

      // Step 1 — produce RunCancelled. Domain validates permission +
      // status guards (e.g. not already finished).
      if (runState.status === 'amending') {
        await assertCanAmendRun(tx, ctx, run);
      } else {
        await assertRunPermissionForAllStores(tx, ctx, run, 'run.create');
      }

      let cancelEvents: RunEvent[] = [];
      try {
        cancelEvents = decideRun(runState, {
          type: 'CancelRun',
          reason: input.reason,
          actor: actorFromCtx(ctx),
        });
      } catch (err) {
        if (err instanceof DomainError) rethrowDomainError(err);
        throw err;
      }
      if (cancelEvents.length > 0) {
        runState = await writeRunEvents(tx, ctx.session!.orgId, runState, cancelEvents);
        // 2026-10-21 audit CA-31: the RunCancelled notification branch
        // existed but was never reached — stores that had just been told
        // "delivery arrived" never learned the run was scrapped.
        await dispatchRunEventNotifications(
          tx,
          ctx.session!.orgId,
          ctx.session!.userId,
          runState,
          cancelEvents,
        );
      }

      // Step 2 — eject every attached session. Sessions that are still
      // `in_run` get `EjectedFromRun` (status → approved). Sessions that
      // somehow drifted out of `in_run` already (defensive) just no-op.
      const sessionIds = runState.sessionIds;
      const ejectionFailures: Array<{ sessionId: string; reason: string }> = [];
      for (const sessionId of sessionIds) {
        const oState = await loadOrderState(tx, sessionId);

        // Only eject if still attached to THIS run. If the session was
        // already manually ejected earlier, skip silently.
        if (oState.status !== 'in_run' || oState.runId !== run.id) continue;

        // M1.7-fix (2026-05-07, audit CRITICAL #2): eject the session
        // with a synthesized `run.eject_session` permission. The cancel-
        // run authorization (run.create) already proved the actor has
        // the right to dismantle this run — if they didn't have
        // run.eject_session in their original permission set, the
        // per-session EjectFromRun would silently fail and leave the
        // run "cancelled" with N orphaned in_run sessions. Granting
        // the perm at this synthesis layer is safe because we're
        // already inside an authorized cancel; we're not letting the
        // actor eject sessions outside of this cancellation.
        const ejectPerms = new Set([...ctx.session!.permissions, 'run.eject_session']);
        let ev: OrderEvent[] = [];
        try {
          ev = decideOrder(oState, {
            type: 'EjectFromRun',
            runId: run.id,
            reason: input.reason,
            actor: orderActorFromCtx(ctx, oState, ejectPerms),
          });
        } catch (err) {
          // Don't let a single session's failure abort the entire cancel
          // (which would leave the run in a half-cancelled state). Log
          // and continue; the operator can manually re-eject if needed.
          if (err instanceof DomainError) {
            ejectionFailures.push({ sessionId, reason: err.message });
            ctx.log.warn(
              { sessionId, runId: run.id, err: err.message },
              'cancel: failed to eject session — left in_run',
            );
            continue;
          }
          throw err;
        }
        await writeOrderEvents(tx, ctx.session!.orgId, sessionId, ev);
      }

      // Realtime ping so connected clients refresh both pages.
      hub.publish(ctx.session!.orgId, {
        type: 'run.changed',
        orgId: ctx.session!.orgId,
        runId: run.id,
        lastSeq: runState.seq,
      });
      for (const sessionId of sessionIds) {
        hub.publish(ctx.session!.orgId, {
          type: 'order.changed',
          orgId: ctx.session!.orgId,
          sessionId,
          lastSeq: -1, // we don't track per-session seq here — clients refetch
        });
      }

      return {
        lastSeq: runState.seq,
        ejectedSessions: sessionIds.length - ejectionFailures.length,
        ejectionFailures,
      };
    });
  }),

  ejectSession: authedProcedure.input(EjectSessionInputSchema).mutation(async ({ ctx, input }) => {
    return withRunStreamRetry(ctx, async (tx) => {
      const run = await loadRun(tx, ctx.session!.orgId, input.runId);
      // M3.33 (2026-05-18, Wave1 #3): scope check. Without this, any
      // actor with run.eject_session could pop another store's
      // session out of a run regardless of their store binding.
      // Match the gate already on runSimpleCommand-driven actions.
      const session = await tx.query.orderSessionsV.findFirst({
        where: (sess, { eq: eq2, and: and2 }) =>
          and2(eq2(sess.id, input.sessionId), eq2(sess.orgId, ctx.session!.orgId)),
        columns: { storeId: true },
      });
      if (!session) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'order.errors.sessionMissing' });
      }
      await assertActorAssignedToStore(
        tx,
        ctx.session!.memberId,
        session.storeId,
        ctx.session!.permissions,
      );
      const effectivePerms = await effectivePermissionsForStore(
        tx,
        ctx.session!.memberId,
        session.storeId,
        ctx.session!.permissions,
      );
      if (!effectivePerms.has('run.eject_session')) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'auth.errors.missingPermission',
          cause: { missingPermission: 'run.eject_session' },
        });
      }

      let runState = await loadRunState(tx, input.runId);

      // Check no per-session items have been touched yet.
      if (runState.status === 'amending') await assertCanAmendRun(tx, ctx, run);

      const sessionItems = await tx.query.orderItemsV.findMany({
        where: (it, { eq: eq2 }) => eq2(it.sessionId, input.sessionId),
      });
      for (const i of sessionItems) {
        const runItem = runState.items.get(i.skuId);
        if (runItem && runItem.status !== 'pending') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'order.errors.cannotEject',
          });
        }
      }

      // RUNAPI-05: in whole thousandths, as in run.create.
      const removedBySku = new Map<string, bigint>();
      for (const item of sessionItems) {
        const qty = qtyMilli(item.qty);
        if (qty <= 0n) continue;
        removedBySku.set(item.skuId, (removedBySku.get(item.skuId) ?? 0n) + qty);
      }
      const removedPlannedItems = [...removedBySku.entries()].map(([skuId, qty]) => ({
        skuId,
        qty: milliQty(qty),
      }));

      try {
        const runRemovalEvents = decideRun(runState, {
          type: 'EjectSession',
          sessionId: input.sessionId,
          removedPlannedItems,
          reason: input.reason,
          actor: actorFromCtx(ctx, effectivePerms),
        });
        if (runRemovalEvents.length > 0) {
          runState = await writeRunEvents(tx, ctx.session!.orgId, runState, runRemovalEvents);
          await dispatchRunEventNotifications(
            tx,
            ctx.session!.orgId,
            ctx.session!.userId,
            runState,
            runRemovalEvents,
          );
        }
      } catch (err) {
        if (err instanceof DomainError) rethrowDomainError(err);
        throw err;
      }

      // Emit EjectedFromRun on the order stream in the same tx.
      const oState = await loadOrderState(tx, input.sessionId);
      const ev = decideOrder(oState, {
        type: 'EjectFromRun',
        runId: input.runId,
        reason: input.reason,
        actor: orderActorFromCtx(ctx, oState, effectivePerms),
      });
      await writeOrderEvents(tx, ctx.session!.orgId, input.sessionId, ev);
      hub.publish(ctx.session!.orgId, {
        type: 'run.changed',
        orgId: ctx.session!.orgId,
        runId: runState.streamId,
        lastSeq: runState.seq,
      });
      hub.publish(ctx.session!.orgId, {
        type: 'order.changed',
        orgId: ctx.session!.orgId,
        sessionId: input.sessionId,
        lastSeq: ev[ev.length - 1]?.seq ?? oState.seq,
      });
      return { lastSeq: runState.seq, orderLastSeq: ev[ev.length - 1]?.seq ?? oState.seq };
    });
  }),
};
