/**
 * How a run command runs: the actor, the run-stream transaction that is
 * decided again when it loses a race, the common pipeline (load, check
 * scope, decide, write, notify, publish), and attaching order sessions.
 */
import { TRPCError } from '@trpc/server';
import { and, eq, ne, sql } from 'drizzle-orm';
import { schema as s, type DB } from '@compass/db';
import type { RunEvent, RunState } from '@compass/domain/run';
import { decide as decideOrder, type OrderState } from '@compass/domain/order';
import { DomainError, todayInTz } from '@compass/domain';
import { rethrowDomainError } from '../../trpc';
import type { RequestContext } from '../../context';
import {
  isStreamSeqConflict,
  isUniqueViolation,
  pgConstraintName,
  withStreamConflictRetry,
} from '../../../services/pgErrors';
import { loadRunState } from '../../../services/runStream';
import { loadOrderState } from '../../../services/orderStream';
import { writeOrderEvents, writeRunEvents } from '../../../services/streamWrite';
import { hub } from '../../../realtime/hub';
import { dispatchRunEventNotifications } from '../../../services/notifyForEvent';
import {
  runInvolvedStoreIds,
  resolveRunReadStoreScope,
  assertCanAmendRun,
  assertRunPermissionForAllStores,
} from './scope';

/**
 * Today as YYYY-MM-DD in the session's ORG timezone. D.1 (M3.39,
 * 2026-05-20) — was UTC-only, which caused new runs created between
 * 00:00 and (org-offset) UTC to land under yesterday's runDate key
 * for UZ tenants. Same helper shape as order.ts:todayInOrgTz.
 */
export function todayStr(ctx: { session: { orgTimezone: string } | null }): string {
  return todayInTz(ctx.session?.orgTimezone ?? 'UTC');
}

export function actorFromCtx(
  ctx: RequestContext,
  /**
   * Optional override for `permissions` — used by store-keyed commands
   * (`deliverToStore`, `confirmStore`, `confirmStoreItem`,
   * `undeliverStore`) to inject the per-store effective set after
   * applying allow/deny overrides for that specific store. Other run
   * commands aggregate across stores so this stays the flat set.
   * (Added 2026-05-06.)
   */
  effectivePermissions?: ReadonlySet<string>,
) {
  return {
    userId: ctx.session!.userId,
    memberId: ctx.session!.memberId,
    permissions: effectivePermissions ?? ctx.session!.permissions,
  };
}

/** The actor for an order command a run handler sends to one session. */
export function orderActorFromCtx(
  ctx: RequestContext,
  session: OrderState,
  permissions?: ReadonlySet<string>,
) {
  return {
    ...actorFromCtx(ctx, permissions),
    isClaimer: session.claimedByMemberId === ctx.session!.memberId,
  };
}

/**
 * AttachToRun on each session's order stream (approved → in_run), for
 * run.create and attachSessions: the orders can no longer be edited or
 * unapproved. Returns each session's last seq for its order.changed push.
 */
export async function attachSessionsToRun(
  tx: DB,
  ctx: RequestContext,
  runId: string,
  sessionIds: readonly string[],
): Promise<Array<{ sessionId: string; lastSeq: number }>> {
  const attached: Array<{ sessionId: string; lastSeq: number }> = [];
  for (const sessionId of sessionIds) {
    const session = await loadOrderState(tx, sessionId);
    const events = decideOrder(session, {
      type: 'AttachToRun',
      runId,
      actor: orderActorFromCtx(ctx, session),
    });
    await writeOrderEvents(tx, ctx.session!.orgId, sessionId, events);
    attached.push({ sessionId, lastSeq: events[events.length - 1]?.seq ?? session.seq });
  }
  return attached;
}

/**
 * Review RUNAPI-04 (2026-11-09): another run.create took the
 * organisation's live-run slot (mrv_one_active_per_org_unique) or this
 * day's run index (mrv_org_date_index_unique) between this one's checks
 * and its insert.
 */
export function isRunSlotConflict(err: unknown): boolean {
  if (!isUniqueViolation(err)) return false;
  const name = pgConstraintName(err);
  return name === 'mrv_one_active_per_org_unique' || name === 'mrv_org_date_index_unique';
}

export const runCreateRetryable = (err: unknown): boolean =>
  isStreamSeqConflict(err) || isRunSlotConflict(err);

/**
 * One run-stream transaction, decided again if it lost a sequence race
 * to another writer (R2, 2026-10-30). Two stores confirming at once, or
 * two buyers recording different lines, used to hand one of them
 * "edited by someone else — try again" (and a replayed offline write was
 * dropped). A race lost on every attempt is still reported as CONFLICT.
 */
export async function withRunStreamRetry<T>(
  ctx: RequestContext,
  fn: (tx: DB) => Promise<T>,
  retryable: (err: unknown) => boolean = isStreamSeqConflict,
): Promise<T> {
  try {
    return await withStreamConflictRetry(() => ctx.withOrg(fn), 3, retryable);
  } catch (err) {
    if (isRunSlotConflict(err)) {
      throw new TRPCError({ code: 'CONFLICT', message: 'run.errors.alreadyPlanned' });
    }
    if (isUniqueViolation(err)) {
      throw new TRPCError({ code: 'CONFLICT', message: 'run.errors.staleSeq' });
    }
    throw err;
  }
}

export async function runSimpleCommand(
  ctx: RequestContext,
  runId: string,
  produce: (
    state: RunState,
    scope: {
      runStoreIds?: string[];
      readStoreIds?: ReadonlySet<string> | null;
      nextRunIndex?: number;
    },
  ) => RunEvent[],
  options?: {
    requireGlobalAmend?: boolean;
    requiredPermission?: string;
    skipRunPermissionScope?: boolean;
    /**
     * 2026-10-21 audit CA-29: resolve the run's session stores and hand
     * them to `produce`, so store-keyed commands can reject splits /
     * deliveries to stores outside the run.
     */
    withRunStoreIds?: boolean;
    /**
     * 2026-10-21: resolve the actor's run READ scope (the same resolver
     * run.get redacts with; null = unrestricted) for commands that must
     * not touch splits the actor was never shown.
     */
    withReadScope?: boolean;
    /** Resolve the next free run number on this date (YYYY-MM-DD). */
    nextRunIndexOn?: string;
    /**
     * BUY-6 (2026-10-30): the command touches one item. A purchaser who
     * runs only some of the run's stores may act on it when every store
     * that item serves (and every store the input splits it to) is theirs.
     */
    item?: { skuId: string; splitStoreIds?: readonly string[] };
    /**
     * D9 (2026-10-31): the command adds or removes an off-catalog expense.
     * A purchaser of some of the run's stores may do so when the expense is
     * split only to their stores (the input's splits when adding, the
     * recorded ones when removing).
     */
    expense?: { expenseId: string; splitStoreIds?: readonly string[] };
  },
): Promise<{ lastSeq: number; eventCount: number }> {
  return withRunStreamRetry(ctx, async (tx) => {
    const run = await loadRun(tx, ctx.session!.orgId, runId);
    let state = await loadRunState(tx, run.id);
    const scope: {
      runStoreIds?: string[];
      readStoreIds?: ReadonlySet<string> | null;
      nextRunIndex?: number;
    } = {
      ...(options?.withRunStoreIds ? { runStoreIds: await runInvolvedStoreIds(tx, run) } : {}),
    };
    if (options?.nextRunIndexOn) {
      const [row] = await tx
        .select({ next: sql<number>`coalesce(max(${s.marketRunsV.runIndex}) + 1, 0)::int` })
        .from(s.marketRunsV)
        .where(
          and(
            eq(s.marketRunsV.orgId, ctx.session!.orgId),
            eq(s.marketRunsV.runDate, options.nextRunIndexOn),
            ne(s.marketRunsV.id, run.id),
          ),
        );
      scope.nextRunIndex = row?.next ?? 0;
    }
    if (options?.withReadScope) {
      const readStoreIds = await resolveRunReadStoreScope(tx, ctx);
      scope.readStoreIds = readStoreIds === null ? null : new Set(readStoreIds);
    }
    if (options?.requireGlobalAmend || state.status === 'amending') {
      await assertCanAmendRun(tx, ctx, run);
    } else if (!options?.skipRunPermissionScope) {
      await assertRunPermissionForAllStores(
        tx,
        ctx,
        run,
        options?.requiredPermission ?? 'run.purchase',
        options?.item
          ? {
              ...options.item,
              purchasedStoreIds: (state.items.get(options.item.skuId)?.storeSplits ?? []).map(
                (split) => split.storeId,
              ),
            }
          : undefined,
        options?.expense
          ? [
              ...(options.expense.splitStoreIds ?? []),
              ...(
                state.expenses.find((expense) => expense.id === options.expense!.expenseId)
                  ?.storeSplits ?? []
              ).map((split) => split.storeId),
            ]
          : undefined,
      );
    }
    try {
      const out = produce(state, scope);
      if (out.length === 0) return { lastSeq: state.seq, eventCount: 0 };
      state = await writeRunEvents(tx, ctx.session!.orgId, state, out);
      await dispatchRunEventNotifications(tx, ctx.session!.orgId, ctx.session!.userId, state, out);
      hub.publish(ctx.session!.orgId, {
        type: 'run.changed',
        orgId: ctx.session!.orgId,
        runId: state.streamId,
        lastSeq: state.seq,
      });
      return { lastSeq: state.seq, eventCount: out.length };
    } catch (err) {
      if (err instanceof DomainError) rethrowDomainError(err);
      // A unique violation goes up as-is: withRunStreamRetry decides it
      // again on the fresh stream, then reports CONFLICT if it keeps losing.
      throw err;
    }
  });
}

export async function loadRun(db: DB, orgId: string, runId: string) {
  const row = await db.query.marketRunsV.findFirst({
    where: (r, { eq: eq2, and: and2 }) => and2(eq2(r.id, runId), eq2(r.orgId, orgId)),
  });
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'run.errors.streamMissing' });
  return row;
}
