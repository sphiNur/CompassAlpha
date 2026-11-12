/**
 * What each maintenance purge removes, as one list per purge (review
 * ADM2-04, 2026-11-11).
 *
 * The four purges (the whole workspace, one date, one order, one run) each
 * wrote every table twice: a count for the preview and a DELETE for the
 * real thing, with WHERE clauses kept alike by hand, half in raw SQL and
 * half in Drizzle. Change one side and the preview no longer said what was
 * deleted. A purge is now a list of steps. The preview counts the rows each
 * step's `where` selects, and the purge deletes those same rows, in the
 * list's order: dependents before what they point at, so that the
 * sub-selects still find their parents.
 *
 * Daily closes are in no list. Every save of one writes a revision, and
 * revisions refuse DELETE (migration 0037), so a purge whose scope holds a
 * close is refused before it counts anything (`refuseIfSettled`).
 */
import { sql, type SQL } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { TRPCError } from '@trpc/server';
import { allowEventPurge, schema as s } from '@compass/db';
import { inTexts, inUuids } from './sqlIn';
import { executeRows } from './sqlRows';

/** What a purge needs of its transaction. */
export interface PurgeTx {
  execute: (query: SQL) => PromiseLike<unknown>;
}

export interface PurgeStep {
  table: PgTable;
  /** The rows of `table` the purge removes, with unqualified column names. */
  where: SQL;
  /**
   * Removed by an ON DELETE CASCADE when a later step deletes the rows
   * they belong to: counted for the preview, never deleted by name.
   */
  cascade?: true;
}

/** `schema.table`: the key a preview's `byTable` has always used. */
export function purgeKey(table: PgTable): string {
  const { schema, name } = getTableConfig(table);
  return schema ? `${schema}.${name}` : name;
}

/**
 * Rows per table, for the preview. One SELECT per step, one after another:
 * they share the purge's transaction.
 */
export async function countPurge(
  tx: PurgeTx,
  steps: readonly PurgeStep[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const step of steps) {
    const rows = executeRows<{ n: number }>(
      await tx.execute(sql`SELECT count(*)::int AS n FROM ${step.table} WHERE ${step.where}`),
    );
    counts[purgeKey(step.table)] = rows[0]?.n ?? 0;
  }
  return counts;
}

/**
 * Deletes what `countPurge` counted, step by step. Two tables need more
 * than a DELETE, whichever purge reaches them: run stock movements first
 * book back what a later stocktake absorbed (`keepCountedStock`), and the
 * event store refuses DELETE unless the transaction allows it (migration
 * 0055). Returns how many stock adjustments were written.
 */
export async function applyPurge(
  tx: PurgeTx,
  steps: readonly PurgeStep[],
  actorMemberId: string,
): Promise<number> {
  let stockKept = 0;
  for (const step of steps) {
    if (step.cascade) continue;
    if (step.table === s.inventoryMovements) {
      stockKept += await keepCountedStock(tx, step.where, actorMemberId);
    }
    if (step.table === s.events) await allowEventPurge(tx);
    await tx.execute(sql`DELETE FROM ${step.table} WHERE ${step.where}`);
  }
  return stockKept;
}

/**
 * Every order, run and event of the organisation, and what hangs off them
 * (admin.purgeAllTestData). The member, catalog and audit rows stay, and so
 * do sync.idempotency_keys and domain.projector_cursors, which belong to
 * the system rather than to one organisation.
 */
export function workspacePurge(orgId: string): PurgeStep[] {
  const runs = sql`(SELECT id FROM ${s.marketRunsV} WHERE org_id = ${orgId})`;
  const sessions = sql`(SELECT id FROM ${s.orderSessionsV} WHERE org_id = ${orgId})`;
  return [
    // 2026-10-21 audit CA-28 (D-08): delivery receipts write stock
    // movements keyed by run; they go with the runs.
    { table: s.inventoryMovements, where: runMovementsIn(orgId, runs) },
    { table: s.runItemStoresV, where: sql`run_id IN ${runs}` },
    { table: s.runItemsV, where: sql`run_id IN ${runs}` },
    // RE-CAT-4: expenses go with their runs (foreign key, ON DELETE CASCADE).
    { table: s.runExpensesV, where: sql`run_id IN ${runs}`, cascade: true },
    { table: s.marketRunsV, where: sql`org_id = ${orgId}` },
    { table: s.orderItemsV, where: sql`session_id IN ${sessions}` },
    { table: s.orderSessionsV, where: sql`org_id = ${orgId}` },
    { table: s.outbox, where: outboxOfOrg(orgId) },
    {
      table: s.snapshots,
      where: sql`stream_id IN (SELECT DISTINCT stream_id FROM ${s.events} WHERE org_id = ${orgId})`,
    },
    { table: s.events, where: sql`org_id = ${orgId}` },
    { table: s.priceHistory, where: sql`org_id = ${orgId}` },
    { table: s.notifications, where: sql`org_id = ${orgId}` },
    { table: s.clientLogs, where: sql`org_id = ${orgId}` },
  ];
}

/**
 * One date's orders and runs (admin.purgeByDate). The caller closes the
 * sets over run links first (CAT-4), so they include the orders and runs of
 * other dates that go with them.
 */
export function datePurge(orgId: string, sessionIds: string[], runIds: string[]): PurgeStep[] {
  return [
    ...runSteps(orgId, runIds),
    ...sessionSteps(orgId, sessionIds),
    ...streamSteps(orgId, [...sessionIds, ...runIds]),
  ];
}

/** One order (admin.purgeSession). */
export function sessionPurge(orgId: string, sessionId: string): PurgeStep[] {
  return [...streamSteps(orgId, [sessionId]), ...sessionSteps(orgId, [sessionId])];
}

/** One run and the orders it holds (admin.purgeRun). */
export function runPurge(orgId: string, runId: string, sessionIds: string[]): PurgeStep[] {
  return [
    ...streamSteps(orgId, [runId, ...sessionIds]),
    ...runSteps(orgId, [runId]),
    ...sessionSteps(orgId, sessionIds),
  ];
}

/** The read models of these runs, and the stock and prices they booked. */
function runSteps(orgId: string, runIds: string[]): PurgeStep[] {
  const runs = inUuids(runIds);
  return [
    { table: s.runItemStoresV, where: sql`run_id IN ${runs}` },
    { table: s.runItemsV, where: sql`run_id IN ${runs}` },
    { table: s.priceHistory, where: sql`org_id = ${orgId} AND run_id IN ${runs}` },
    { table: s.inventoryMovements, where: runMovements(orgId, runIds) },
    // CAT-14 (2026-10-30): expenses go with their run (ON DELETE CASCADE).
    { table: s.runExpensesV, where: sql`run_id IN ${runs}`, cascade: true },
    { table: s.marketRunsV, where: sql`org_id = ${orgId} AND id IN ${runs}` },
  ];
}

/** The read models of these orders. */
function sessionSteps(orgId: string, sessionIds: string[]): PurgeStep[] {
  const sessions = inUuids(sessionIds);
  return [
    { table: s.orderItemsV, where: sql`session_id IN ${sessions}` },
    { table: s.orderSessionsV, where: sql`org_id = ${orgId} AND id IN ${sessions}` },
  ];
}

/**
 * The events of these order and run streams, and what is keyed to them.
 * Outbox rows go before the events their event_id points at.
 */
function streamSteps(orgId: string, streamIds: string[]): PurgeStep[] {
  const streams = inUuids(streamIds);
  return [
    { table: s.notifications, where: notificationsOfStreams(orgId, streamIds) },
    { table: s.outbox, where: outboxOfStreams(orgId, streamIds) },
    { table: s.snapshots, where: sql`stream_id IN ${streams}` },
    { table: s.events, where: sql`org_id = ${orgId} AND stream_id IN ${streams}` },
  ];
}

/**
 * Notifications about these orders and runs: notify.ts and the worker put
 * the sessionId or runId at the top of the payload.
 */
export function notificationsOfStreams(orgId: string, streamIds: string[]): SQL {
  if (streamIds.length === 0) return sql`false`;
  const texts = inTexts(streamIds);
  return sql`(org_id = ${orgId}
    AND (payload->>'sessionId' IN ${texts} OR payload->>'runId' IN ${texts}))`;
}

/**
 * 2026-10-21 audit CA-28 (F-05): which sync.outbox rows belong to an org.
 * Notification rows (the only producer today, notify.ts) store
 * event_id = orgId and carry `orgId` in the payload; anything keyed to a
 * real domain event is matched through domain.events.
 */
export function outboxOfOrg(orgId: string): SQL {
  return sql`(event_id IN (SELECT id FROM ${s.events} WHERE org_id = ${orgId})
    OR (aggregate = 'notification' AND payload->>'orgId' = ${orgId}))`;
}

/**
 * Outbox rows for a set of order and run streams: event-keyed rows through
 * domain.events, notification rows through the sessionId or runId that the
 * notification payload carries under `extra`.
 */
export function outboxOfStreams(orgId: string, streamIds: string[]): SQL {
  if (streamIds.length === 0) return sql`false`;
  const texts = inTexts(streamIds);
  return sql`(event_id IN (
      SELECT id FROM ${s.events} WHERE org_id = ${orgId} AND stream_id IN ${inUuids(streamIds)}
    )
    OR (aggregate = 'notification' AND payload->>'orgId' = ${orgId}
      AND (payload->'extra'->>'sessionId' IN ${texts}
        OR payload->'extra'->>'runId' IN ${texts})))`;
}

/** 2026-10-21 audit CA-28 (D-08): the stock movements written for these runs. */
export function runMovements(orgId: string, runIds: string[]): SQL {
  if (runIds.length === 0) return sql`false`;
  return runMovementsIn(orgId, inUuids(runIds));
}

/** DLV-3: corrections of a finished run book 'run_amend' rows too. */
function runMovementsIn(orgId: string, runs: SQL): SQL {
  return sql`(org_id = ${orgId} AND source_type IN ('run', 'run_amend') AND source_id IN ${runs})`;
}

/**
 * CAT-2 (2026-10-30): a daily close cannot be purged, and a purge whose
 * scope holds one used to fail with a bare "something went wrong". It now
 * says why before counting anything, its preview too. The scope is the
 * organisation, or one date of it. A close always has a revision, but both
 * tables are asked, so that neither is ever left behind half-deleted.
 */
export async function refuseIfSettled(tx: PurgeTx, orgId: string, date?: string): Promise<void> {
  const scope =
    date === undefined
      ? sql`org_id = ${orgId}`
      : sql`org_id = ${orgId} AND settlement_date = ${date}`;
  const rows = executeRows<{ settled: boolean }>(
    await tx.execute(
      sql`SELECT (EXISTS (SELECT 1 FROM ${s.storeDailySettlements} WHERE ${scope})
      OR EXISTS (SELECT 1 FROM ${s.storeDailySettlementRevisions} WHERE ${scope})) AS settled`,
    ),
  );
  if (rows[0]?.settled) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'admin.errors.purgeHasSettlements',
    });
  }
}

/**
 * Review ADM2-02 (2026-11-10): call before deleting the run movements that
 * `which` selects (its columns are those of inventory.movements).
 *
 * Stock on hand is the sum of the ledger, and a stocktake writes the delta
 * that brings the sum to what was counted, so it has already absorbed every
 * receipt booked before it. Deleting such a receipt with its run took it
 * out a second time: the store then showed less than it had counted, or a
 * negative stock. For each store, product and run, the receipts that a
 * later stocktake absorbed are booked back as one 'adjustment' (source
 * 'purge', the run's id), so on hand stays what was counted. Receipts after
 * the last stocktake are not booked back: the goods of a test run never
 * arrived. Returns how many adjustments were written.
 */
async function keepCountedStock(tx: PurgeTx, which: SQL, actorMemberId: string): Promise<number> {
  const rows = executeRows<{ id: string }>(
    await tx.execute(sql`
    INSERT INTO inventory.movements
      (org_id, store_id, sku_id, delta, reason, source_type, source_id, actor_member_id)
    SELECT m.org_id, m.store_id, m.sku_id, SUM(m.delta), 'adjustment', 'purge', m.source_id,
           ${actorMemberId}
      FROM inventory.movements m
     WHERE ${which}
       AND EXISTS (
         SELECT 1 FROM inventory.movements st
          WHERE st.org_id = m.org_id AND st.store_id = m.store_id AND st.sku_id = m.sku_id
            AND st.reason = 'stocktake' AND st.occurred_at > m.occurred_at)
     GROUP BY m.org_id, m.store_id, m.sku_id, m.source_id
    HAVING SUM(m.delta) <> 0
    RETURNING id`),
  );
  return rows.length;
}
