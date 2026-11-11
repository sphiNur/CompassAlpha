/**
 * Who may delete what from the maintenance page.
 *
 * Review ADM2-08 (2026-11-11): the lists there show on each order and run
 * whether it can be deleted, and why not (DX-CAT-3), and the deletes
 * refuse for the same reasons (CAT-3, RE-CAT-1, R2-CAT-1). The checks were
 * written out twice, once per row for the lists and once for the delete,
 * each with its own pair of database helpers, so the list could promise a
 * delete that the delete then refused. Both now read the rule below.
 */
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { schema as s, type DB } from '@compass/db';
import type { CatalogKey } from '@compass/i18n';

/** Why an order cannot be deleted here. */
export type SessionDeleteBlock =
  | 'notSuperAdmin'
  | 'inRun'
  | 'othersOrder'
  | 'othersLines'
  | 'actedOnByOthers';

/** Why a run cannot be deleted here. */
export type RunDeleteBlock = 'notSuperAdmin' | 'foreignSessions' | 'actedOnByOthers';

/** The admin who deletes, from their session. */
export interface PurgeCaller {
  orgId: string;
  userId: string;
  memberId: string;
  roleSlugs: ReadonlySet<string>;
}

/**
 * The deletes' `requireOnlyTestSessions`. On (the default, and what the
 * page sends), only the caller's test data goes: nothing someone else
 * wrote or acted on. Off, only the role and, for an order, its run are
 * checked; production refuses that without the bulk-purge switch
 * (R2-CAT-2).
 */
export interface PurgeGuard {
  requireOnlyTestSessions: boolean;
}

/** The order columns the rule reads. */
export interface SessionToDelete {
  id: string;
  status: string;
  runId: string | null;
  initiatedByMemberId: string | null;
  submittedByMemberId: string | null;
}

/** A run and the orders it holds. */
export interface RunToDelete {
  id: string;
  sessionIds: readonly string[];
}

/** What the database says about a batch of orders. */
export interface SessionFacts {
  /** The runs, of those the orders point at, that still exist. */
  liveRunIds: ReadonlySet<string>;
  /** The orders with a line someone else wrote. */
  othersLines: ReadonlySet<string>;
  /** The orders someone else wrote an event on: approved, rejected, claimed. */
  actedOn: ReadonlySet<string>;
}

/** What the database says about a batch of runs. */
export interface RunFacts {
  /** Their orders that someone else wrote, or wrote a line in. */
  foreignSessions: ReadonlySet<string>;
  /** The runs someone else wrote an event on: claimed, bought, delivered. */
  actedOnRuns: ReadonlySet<string>;
  /** Their orders someone else wrote an event on. */
  actedOnSessions: ReadonlySet<string>;
}

/** Only a super admin deletes data, one item or in bulk. */
export function canPurge(caller: Pick<PurgeCaller, 'roleSlugs'>): boolean {
  return caller.roleSlugs.has('super_admin');
}

/** Refuses anyone `canPurge` refuses. Every purge calls it first. */
export function requirePurgeRole(caller: Pick<PurgeCaller, 'roleSlugs'>): void {
  if (!canPurge(caller)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'admin.errors.purgeRequiresSuperAdmin' });
  }
}

/**
 * CAT-3: whose work an order is. Someone else's when they submitted it
 * (or, before submit, started it); the caller's own with someone else's
 * lines in it when another member wrote a line (per-store orders have
 * several contributors). Null when it is all the caller's.
 */
function othersWork(
  session: Pick<SessionToDelete, 'id' | 'initiatedByMemberId' | 'submittedByMemberId'>,
  caller: PurgeCaller,
  othersLines: ReadonlySet<string>,
): 'othersOrder' | 'othersLines' | null {
  const author = session.submittedByMemberId ?? session.initiatedByMemberId;
  if (author !== null && author !== caller.memberId) return 'othersOrder';
  return othersLines.has(session.id) ? 'othersLines' : null;
}

/** Why `caller` may not delete this order, or null when they may. */
export function sessionDeleteBlock(
  session: SessionToDelete,
  caller: PurgeCaller,
  facts: SessionFacts,
  guard: PurgeGuard,
): SessionDeleteBlock | null {
  if (!canPurge(caller)) return 'notSuperAdmin';
  // An order in a run goes with its run (purgeRun). One whose run is
  // already gone, left behind by an earlier purge (CAT-4), has nothing
  // to go with, so it may go alone.
  const runIsLive = session.runId !== null && facts.liveRunIds.has(session.runId);
  const orphaned = session.runId !== null && !runIsLive;
  if (!orphaned && (session.status === 'in_run' || session.status === 'archived' || runIsLive)) {
    return 'inRun';
  }
  if (!guard.requireOnlyTestSessions) return null;
  const others = othersWork(session, caller, facts.othersLines);
  if (others) return others;
  // R2-CAT-1: the caller's own, but someone else approved, rejected or
  // claimed it.
  return facts.actedOn.has(session.id) ? 'actedOnByOthers' : null;
}

/** Why `caller` may not delete this run with its orders, or null when they may. */
export function runDeleteBlock(
  run: RunToDelete,
  caller: PurgeCaller,
  facts: RunFacts,
  guard: PurgeGuard,
): RunDeleteBlock | null {
  if (!canPurge(caller)) return 'notSuperAdmin';
  if (!guard.requireOnlyTestSessions) return null;
  if (run.sessionIds.some((id) => facts.foreignSessions.has(id))) return 'foreignSessions';
  // RE-CAT-1: anyone else acting on the run or on its orders makes it real
  // data; deleting it would take its price history and stock with it.
  // R2-CAT-1: a reason of its own, as the orders are the caller's.
  const actedOn =
    facts.actedOnRuns.has(run.id) || run.sessionIds.some((id) => facts.actedOnSessions.has(id));
  return actedOn ? 'actedOnByOthers' : null;
}

const NONE: ReadonlySet<string> = new Set();

/** Why `caller` may not delete each of these orders, by order id (null: they may). */
export async function sessionDeleteBlocks(
  tx: DB,
  caller: PurgeCaller,
  sessions: readonly SessionToDelete[],
  guard: PurgeGuard,
): Promise<Map<string, SessionDeleteBlock | null>> {
  const ids = sessions.map((x) => x.id);
  const runIds = [...new Set(sessions.flatMap((x) => (x.runId === null ? [] : [x.runId])))];
  const [liveRunIds, othersLines, actedOn] = await Promise.all([
    existingRuns(tx, caller.orgId, runIds),
    guard.requireOnlyTestSessions ? sessionsWithOthersLines(tx, caller, ids) : NONE,
    guard.requireOnlyTestSessions ? streamsActedOnByOthers(tx, caller, 'order', ids) : NONE,
  ]);
  const facts: SessionFacts = { liveRunIds, othersLines, actedOn };
  return new Map(sessions.map((x) => [x.id, sessionDeleteBlock(x, caller, facts, guard)]));
}

/** Why `caller` may not delete each of these runs, by run id (null: they may). */
export async function runDeleteBlocks(
  tx: DB,
  caller: PurgeCaller,
  runs: readonly RunToDelete[],
  guard: PurgeGuard,
): Promise<Map<string, RunDeleteBlock | null>> {
  const sessionIds = [...new Set(runs.flatMap((r) => r.sessionIds))];
  const [foreignSessions, actedOnRuns, actedOnSessions] = guard.requireOnlyTestSessions
    ? await Promise.all([
        sessionsWithOthersWork(tx, caller, sessionIds),
        streamsActedOnByOthers(
          tx,
          caller,
          'run',
          runs.map((r) => r.id),
        ),
        streamsActedOnByOthers(tx, caller, 'order', sessionIds),
      ])
    : [NONE, NONE, NONE];
  const facts: RunFacts = { foreignSessions, actedOnRuns, actedOnSessions };
  return new Map(runs.map((r) => [r.id, runDeleteBlock(r, caller, facts, guard)]));
}

/** What a delete answers for each reason (the lists word it for the row). */
const SESSION_REFUSALS = {
  notSuperAdmin: 'admin.errors.purgeRequiresSuperAdmin',
  inRun: 'admin.errors.sessionAttachedToRun',
  othersOrder: 'admin.errors.sessionHasForeignAuthors',
  othersLines: 'admin.errors.sessionHasForeignAuthors',
  actedOnByOthers: 'admin.errors.sessionActedOnByOthers',
} as const satisfies Record<SessionDeleteBlock, CatalogKey>;

const RUN_REFUSALS = {
  notSuperAdmin: 'admin.errors.purgeRequiresSuperAdmin',
  foreignSessions: 'admin.errors.runHasForeignSessions',
  actedOnByOthers: 'admin.errors.runActedOnByOthers',
} as const satisfies Record<RunDeleteBlock, CatalogKey>;

function refusal(block: SessionDeleteBlock | RunDeleteBlock, message: CatalogKey): TRPCError {
  return new TRPCError({ code: block === 'notSuperAdmin' ? 'FORBIDDEN' : 'BAD_REQUEST', message });
}

/** purgeSession's error for a block. */
export function sessionDeleteRefusal(block: SessionDeleteBlock): TRPCError {
  return refusal(block, SESSION_REFUSALS[block]);
}

/** purgeRun's error for a block. */
export function runDeleteRefusal(block: RunDeleteBlock): TRPCError {
  return refusal(block, RUN_REFUSALS[block]);
}

/** Which of these runs still exist. */
async function existingRuns(tx: DB, orgId: string, runIds: string[]): Promise<Set<string>> {
  if (runIds.length === 0) return new Set();
  const rows = await tx
    .select({ id: s.marketRunsV.id })
    .from(s.marketRunsV)
    .where(and(eq(s.marketRunsV.orgId, orgId), inArray(s.marketRunsV.id, runIds)));
  return new Set(rows.map((r) => r.id));
}

/** Which of these orders have a line another member wrote. */
async function sessionsWithOthersLines(
  tx: DB,
  caller: PurgeCaller,
  sessionIds: string[],
): Promise<Set<string>> {
  if (sessionIds.length === 0) return new Set();
  const rows = await tx
    .selectDistinct({ sessionId: s.orderItemsV.sessionId })
    .from(s.orderItemsV)
    .where(
      and(
        inArray(s.orderItemsV.sessionId, sessionIds),
        ne(s.orderItemsV.contributorMemberId, caller.memberId),
      ),
    );
  return new Set(rows.map((r) => r.sessionId));
}

/** Which of these orders are someone else's work (othersWork). */
async function sessionsWithOthersWork(
  tx: DB,
  caller: PurgeCaller,
  sessionIds: string[],
): Promise<Set<string>> {
  if (sessionIds.length === 0) return new Set();
  const [sessions, othersLines] = await Promise.all([
    tx
      .select({
        id: s.orderSessionsV.id,
        initiatedByMemberId: s.orderSessionsV.initiatedByMemberId,
        submittedByMemberId: s.orderSessionsV.submittedByMemberId,
      })
      .from(s.orderSessionsV)
      .where(
        and(eq(s.orderSessionsV.orgId, caller.orgId), inArray(s.orderSessionsV.id, sessionIds)),
      ),
    sessionsWithOthersLines(tx, caller, sessionIds),
  ]);
  // A line goes with its order (foreign key), so every order in
  // `othersLines` is one of `sessions`.
  return new Set(sessions.filter((x) => othersWork(x, caller, othersLines)).map((x) => x.id));
}

/**
 * Which of these streams someone other than the caller wrote an event on.
 * Events without an actor (the system's) do not count.
 */
async function streamsActedOnByOthers(
  tx: DB,
  caller: PurgeCaller,
  type: 'run' | 'order',
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await tx
    .selectDistinct({ streamId: s.events.streamId })
    .from(s.events)
    .where(
      and(
        eq(s.events.orgId, caller.orgId),
        eq(s.events.streamType, type),
        inArray(s.events.streamId, ids),
        isNotNull(s.events.actorId),
        ne(s.events.actorId, caller.userId),
      ),
    );
  return new Set(rows.map((r) => r.streamId));
}
