/**
 * Closing a run: finishing it, reopening it to amend, moving its date,
 * and finishing it again after an amendment.
 */
import { TRPCError } from '@trpc/server';
import {
  ChangeRunDateInputSchema,
  RunReasonOnlyInputSchema,
  SimpleRunCommandSchema,
} from '@compass/contracts';
import { decideRun, type RunEvent } from '@compass/domain/run';
import { decide as decideOrder, type OrderEvent } from '@compass/domain/order';
import { DomainError } from '@compass/domain';
import { authedProcedure, idempotentMutation, rethrowDomainError } from '../../trpc';
import { loadOrderState, loadRunState, writeOrderEvents } from '@compass/streams';
import { writeRunEvents } from '../../../services/streamWrite';
import { hub } from '../../../realtime/hub';
import { dispatchRunEventNotifications } from '../../../services/notifyForEvent';
import { orgToday } from '../../../services/timeZone';
import {
  actorFromCtx,
  orderActorFromCtx,
  withRunStreamRetry,
  runSimpleCommand,
  loadRun,
} from './command';
import { assertCanAmendRun, assertRunPermissionForAllStores } from './scope';

export const closeProcedures = {
  /**
   * Finish the run. Cascading effect (added 2026-05-03):
   *
   *   1. RunFinished on the run stream (status → finished)
   *   2. Archived on each attached session stream (status → archived)
   *
   * Without step 2 the sessions stay at `in_run` forever, even though
   * the goods have been delivered and confirmed. The order page would
   * keep showing "submitted · in run" with no way to reach a clean
   * "done" state, and the same SKU couldn't appear in a future run
   * (would conflict on the in_run guard).
   *
   * After the cascade, the run + its sessions are visible in the
   * RunPage history view but no longer occupy the active spots on
   * Order / Approval / Run pages.
   *
   * M3.4 (2026-05-15) — ATOMICITY:
   *   The original implementation logged + continued on a session's
   *   Archive failure, leaving Step 1's RunFinished event committed
   *   while one or more sessions remained `in_run`. Result: the run
   *   showed "finished" but the session stayed pinned and couldn't
   *   be re-used in a future run — silently wedged forever.
   *
   *   Now the entire cascade runs inside `ctx.withOrg` (one tx).
   *   Every session the domain refuses to archive goes into
   *   `archiveFailures`; if the list is non-empty after the loop we
   *   throw, which rolls back BOTH the RunFinished event AND any
   *   partial session archives. The operator gets a structured error
   *   with the full failure list and retries after fixing the cause.
   *   A database error ends the transaction at once (RUNAPI-09): a
   *   sequence race is decided again by withRunStreamRetry.
   *
   *   Re-running `finish` on a partially-archived state is safe
   *   thanks to the `if (oState.status === 'archived') continue`
   *   skip at line ~906 — already-archived sessions become no-ops.
   *   Combined with idempotentMutation, the whole flow tolerates
   *   network retries without producing duplicate events.
   */
  // M1.20: idempotent — finish locks the run + writes totals; a
  // retry must NOT compute a second total.
  finish: idempotentMutation.input(SimpleRunCommandSchema).mutation(async ({ ctx, input }) => {
    return withRunStreamRetry(ctx, async (tx) => {
      const run = await loadRun(tx, ctx.session!.orgId, input.runId);
      let runState = await loadRunState(tx, run.id);

      // Step 1 — RunFinished on the run stream.
      if (runState.status === 'amending') {
        await assertCanAmendRun(tx, ctx, run);
      } else {
        await assertRunPermissionForAllStores(tx, ctx, run, 'run.finish');
      }

      let finishEvents: RunEvent[] = [];
      try {
        finishEvents = decideRun(runState, {
          type: 'FinishRun',
          actor: actorFromCtx(ctx),
        });
      } catch (err) {
        if (err instanceof DomainError) rethrowDomainError(err);
        throw err;
      }
      if (finishEvents.length > 0) {
        runState = await writeRunEvents(tx, ctx.session!.orgId, runState, finishEvents);
        await dispatchRunEventNotifications(
          tx,
          ctx.session!.orgId,
          ctx.session!.userId,
          runState,
          finishEvents,
        );
      }

      // Step 2 — Archive every attached session.
      //
      // M3.4: collect failures, do NOT continue silently. If any
      // session can't be archived, the whole tx (including the
      // RunFinished event committed in Step 1) rolls back so we
      // never end up with run.status='finished' AND session.status
      // ='in_run' on the same data.
      const archiveFailures: Array<{ sessionId: string; reason: string }> = [];
      for (const sessionId of runState.sessionIds) {
        const oState = await loadOrderState(tx, sessionId);
        if (oState.status === 'archived') continue; // already archived → no-op

        let ev: OrderEvent[] = [];
        try {
          ev = decideOrder(oState, {
            type: 'Archive',
            reason: 'run_finished',
            actor: orderActorFromCtx(ctx, oState),
          });
        } catch (err) {
          if (err instanceof DomainError) {
            archiveFailures.push({ sessionId, reason: err.message });
            ctx.log.warn(
              { sessionId, runId: run.id, err: err.message },
              'finish: failed to archive session — will roll back the run-finish',
            );
            continue;
          }
          throw err;
        }
        // RUNAPI-09 (2026-11-09): a database error here is not collected.
        // It aborts the transaction, so the next session's read failed
        // anyway, and a sequence race (someone marking an extra at that
        // moment) answered 500 instead of being decided again. It goes
        // out as it is: withRunStreamRetry runs the whole finish again
        // on the fresh streams, and anything else rolls it back.
        await writeOrderEvents(tx, ctx.session!.orgId, sessionId, ev);
      }

      // M3.4 atomicity bar — if the domain refused any session, abort
      // the whole tx by throwing. ctx.withOrg's transaction roll-back
      // undoes the Step-1 RunFinished event AND the archives written in
      // this loop before it.
      if (archiveFailures.length > 0) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'run.errors.archiveCascadeFailed',
          cause: {
            runId: run.id,
            archiveFailures,
          },
        });
      }

      // Realtime nudge so connected order/approve clients refresh.
      hub.publish(ctx.session!.orgId, {
        type: 'run.changed',
        orgId: ctx.session!.orgId,
        runId: run.id,
        lastSeq: runState.seq,
      });
      for (const sessionId of runState.sessionIds) {
        hub.publish(ctx.session!.orgId, {
          type: 'order.changed',
          orgId: ctx.session!.orgId,
          sessionId,
          lastSeq: -1,
        });
      }

      // archiveFailures is always empty on success (any non-empty
      // list would have thrown above). Kept in the response shape
      // for FE backwards compat — older clients may still read it.
      return {
        lastSeq: runState.seq,
        archiveFailures: [] as Array<{ sessionId: string; reason: string }>,
      };
    });
  }),

  /**
   * 2026-07-06: super-admin (run.amend) reopens a FINISHED run to correct
   * it. Moves finished → amending, which unlocks the normal edit
   * procedures (revisePurchase / addPurchaserItem / undoPurchase /
   * add|removeExpense) for run.amend holders. Close with `refinalize`,
   * which recomputes + re-freezes the totals. The domain enforces the
   * permission + finished-only guard.
   */
  reopen: authedProcedure.input(RunReasonOnlyInputSchema).mutation(async ({ ctx, input }) =>
    runSimpleCommand(
      ctx,
      input.runId,
      (state) =>
        decideRun(state, {
          type: 'ReopenRun',
          reason: input.reason,
          actor: actorFromCtx(ctx),
        }),
      { requireGlobalAmend: true },
    ),
  ),

  /**
   * Correct the calendar date a run's spend is booked under.
   *
   * Deliberately NOT wrapped in reopen → change → refinalize: this
   * touches no money, and refinalize would rewrite the run's frozen
   * totals as a side effect of a pure date fix. Works on finished runs
   * directly; the domain rejects only `cancelled`.
   */
  changeDate: authedProcedure.input(ChangeRunDateInputSchema).mutation(async ({ ctx, input }) =>
    runSimpleCommand(
      ctx,
      input.runId,
      (state, { nextRunIndex }) => {
        // HIS-7 (2026-10-30): the same rule as creating a run — never a
        // day that has not come yet in the org's time zone. Checked after
        // the amend gate so a caller without it hears about that first.
        if (input.runDate > orgToday(ctx.session)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'run.errors.runDateInFuture' });
        }
        return decideRun(state, {
          type: 'ChangeRunDate',
          runDate: input.runDate,
          runIndex: nextRunIndex,
          actor: actorFromCtx(ctx),
        });
      },
      // 2026-10-23: runs are numbered per day (unique org + date + index);
      // moving a run onto a day that already has a run #0 hit that index
      // and surfaced as "edited by someone else". It now becomes that
      // day's next run.
      { requireGlobalAmend: true, nextRunIndexOn: input.runDate },
    ),
  ),

  /** Close a super-admin correction: recompute + re-freeze the run
   *  totals and return amending → finished. */
  refinalize: authedProcedure
    .input(SimpleRunCommandSchema)
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(ctx, input.runId, (state) =>
        decideRun(state, { type: 'RefinalizeRun', actor: actorFromCtx(ctx) }),
      ),
    ),
};
