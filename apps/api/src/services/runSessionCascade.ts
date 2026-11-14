/**
 * What a run does to the order sessions it carries (review RUNAPI-13,
 * 2026-11-12): it takes approved orders in (AttachToRun: run.create,
 * run.attachSessions), lets one go (EjectFromRun: run.ejectSession) or
 * all of them (run.cancel), and archives them when it finishes (Archive:
 * run.finish). Each router wrote its cascade out itself.
 *
 * Every order event is written in the caller's transaction, after the
 * run's own events. A refusal of an attach or of a single eject is the
 * domain's DomainError, for the router to answer with
 * (`rethrowDomainError`); the cancel and the finish collect theirs, as
 * each always has: the cancel goes on without the session, the finish
 * rolls back. `publishRunAndSessions` is the push each of them sends.
 */
import { TRPCError } from '@trpc/server';
import type { DB } from '@compass/db';
import { DomainError } from '@compass/domain';
import { decide as decideOrder, type OrderEvent, type OrderState } from '@compass/domain/order';
import type { logger } from '../infra/log';
import { hub } from '../realtime/hub';
import { loadOrderState, writeOrderEvents } from '@compass/streams';

/** Who sends the run command; the order commands go out in their name. */
export interface CascadeActor {
  userId: string;
  memberId: string;
  permissions: ReadonlySet<string>;
}

/** A session and its order stream's last seq after the cascade (-1: unknown). */
export interface SessionSeq {
  sessionId: string;
  lastSeq: number;
}

/** A session the domain would not let go of, and its error key. */
export interface SessionFailure {
  sessionId: string;
  reason: string;
}

type Log = Pick<typeof logger, 'warn'>;

/** The order actor for one session: its claimer or not. */
function orderActor(
  actor: CascadeActor,
  session: OrderState,
  permissions: ReadonlySet<string> = actor.permissions,
) {
  return {
    userId: actor.userId,
    memberId: actor.memberId,
    permissions,
    isClaimer: session.claimedByMemberId === actor.memberId,
  };
}

/**
 * AttachToRun on each session's order stream (approved → in_run): the
 * orders can no longer be edited or unapproved. An order unapproved since
 * the read model said `approved` is refused by the domain (RUNAPI-20).
 */
export async function attachSessionsToRun(
  tx: DB,
  orgId: string,
  actor: CascadeActor,
  runId: string,
  sessionIds: readonly string[],
): Promise<SessionSeq[]> {
  const attached: SessionSeq[] = [];
  for (const sessionId of sessionIds) {
    const session = await loadOrderState(tx, sessionId);
    const events = decideOrder(session, {
      type: 'AttachToRun',
      runId,
      actor: orderActor(actor, session),
    });
    await writeOrderEvents(tx, orgId, sessionId, events);
    attached.push({ sessionId, lastSeq: events[events.length - 1]?.seq ?? session.seq });
  }
  return attached;
}

/**
 * EjectFromRun on one session's order stream (in_run → approved), for
 * run.ejectSession once the run let it go. A refusal (the order changed
 * since the run was read) is the client's answer (RUNAPI-20).
 */
export async function ejectSessionFromRun(
  tx: DB,
  orgId: string,
  actor: CascadeActor,
  runId: string,
  sessionId: string,
  reason: string | undefined,
): Promise<SessionSeq> {
  const session = await loadOrderState(tx, sessionId);
  const events = decideOrder(session, {
    type: 'EjectFromRun',
    runId,
    reason,
    actor: orderActor(actor, session),
  });
  await writeOrderEvents(tx, orgId, sessionId, events);
  return { sessionId, lastSeq: events[events.length - 1]?.seq ?? session.seq };
}

/**
 * run.cancel: every session still in this run goes back to `approved`, so
 * it can be planned again; one already out of it is skipped.
 *
 * M1.7-fix (2026-05-07, audit CRITICAL #2): the sessions are let go with
 * `run.eject_session` added to the actor's permissions. The cancel's own
 * authorization (run.create) already proved the actor may dismantle this
 * run; without the key the per-session EjectFromRun would fail and leave
 * the run cancelled with its sessions stuck `in_run`. The key is granted
 * for this cascade only.
 *
 * A session the domain refuses does not stop the cancel (the run would be
 * half cancelled): it stays `in_run`, is logged and comes back in the
 * list, for an operator to eject again.
 */
export async function ejectSessionsOfCancelledRun(
  tx: DB,
  orgId: string,
  actor: CascadeActor,
  runId: string,
  sessionIds: readonly string[],
  reason: string,
  log: Log,
): Promise<SessionFailure[]> {
  const failures: SessionFailure[] = [];
  const ejectPerms = new Set([...actor.permissions, 'run.eject_session']);
  for (const sessionId of sessionIds) {
    const session = await loadOrderState(tx, sessionId);
    // Only a session still attached to THIS run; one ejected earlier is
    // skipped.
    if (session.status !== 'in_run' || session.runId !== runId) continue;
    let events: OrderEvent[];
    try {
      events = decideOrder(session, {
        type: 'EjectFromRun',
        runId,
        reason,
        actor: orderActor(actor, session, ejectPerms),
      });
    } catch (err) {
      if (err instanceof DomainError) {
        failures.push({ sessionId, reason: err.message });
        log.warn(
          { sessionId, runId, err: err.message },
          'cancel: failed to eject session — left in_run',
        );
        continue;
      }
      throw err;
    }
    await writeOrderEvents(tx, orgId, sessionId, events);
  }
  return failures;
}

/**
 * run.finish: every session of the run is archived (an archived one is
 * skipped, so a finish run again is safe).
 *
 * M3.4 (2026-05-15), atomicity: a session the domain refuses to archive
 * is collected, and if any was, this throws, which rolls back the whole
 * transaction: the RunFinished event and the archives written before it.
 * A run never ends finished with a session still `in_run`. A database
 * error is not collected (RUNAPI-09): it ends the transaction at once,
 * and withRunStreamRetry decides a sequence race again.
 */
export async function archiveSessionsOfFinishedRun(
  tx: DB,
  orgId: string,
  actor: CascadeActor,
  runId: string,
  sessionIds: readonly string[],
  log: Log,
): Promise<void> {
  const archiveFailures: SessionFailure[] = [];
  for (const sessionId of sessionIds) {
    const session = await loadOrderState(tx, sessionId);
    if (session.status === 'archived') continue;
    let events: OrderEvent[];
    try {
      events = decideOrder(session, {
        type: 'Archive',
        reason: 'run_finished',
        actor: orderActor(actor, session),
      });
    } catch (err) {
      if (err instanceof DomainError) {
        archiveFailures.push({ sessionId, reason: err.message });
        log.warn(
          { sessionId, runId, err: err.message },
          'finish: failed to archive session — will roll back the run-finish',
        );
        continue;
      }
      throw err;
    }
    await writeOrderEvents(tx, orgId, sessionId, events);
  }
  if (archiveFailures.length > 0) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'run.errors.archiveCascadeFailed',
      cause: { runId, archiveFailures },
    });
  }
}

/**
 * run.changed, then order.changed for each session, sent once the
 * transaction commits. A cascade that does not track a session's seq
 * sends -1: clients refetch.
 */
export function publishRunAndSessions(
  orgId: string,
  runId: string,
  runLastSeq: number,
  sessions: readonly SessionSeq[],
): void {
  hub.publish(orgId, { type: 'run.changed', orgId, runId, lastSeq: runLastSeq });
  for (const { sessionId, lastSeq } of sessions) {
    hub.publish(orgId, { type: 'order.changed', orgId, sessionId, lastSeq });
  }
}
