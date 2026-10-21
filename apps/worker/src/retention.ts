/**
 * Retention for append-only operational tables (2026-10-21 audit CA-38).
 *
 * ops.notifications, sync.outbox and ops.client_logs only ever grew: the
 * worker marks outbox rows sent and never removes them, every bot/in-app
 * notification stays forever, and client telemetry is written on every
 * page error. None of them is a source of truth (the event log is), so
 * they are trimmed hourly alongside the idempotency/refresh-token
 * cleanup in main.ts.
 *
 * Deletes are BATCHED: one `DELETE … WHERE id IN (SELECT … LIMIT n)` per
 * transaction, so the first run on a table holding months of history
 * does not take one long lock (and one huge WAL burst) while the outbox
 * flush is trying to write to the same table. A tick is also capped at
 * `maxBatches`; anything left over is picked up an hour later.
 *
 * The table/column names are constants in this file, never input, which
 * is why the SQL builder can splice them in with sql.raw.
 */
import { sql, type SQL } from 'drizzle-orm';

export interface RetentionRule {
  /** Log label. */
  name: string;
  /** Schema-qualified table, e.g. `ops.notifications`. */
  table: string;
  /** Timestamp column whose age decides deletion. */
  column: string;
  /** Rows whose `column` is older than this many days are deleted. */
  days: number;
}

export const RETENTION_RULES: readonly RetentionRule[] = [
  // In-app/bot notification history. 90 days covers any "what did I get
  // told about last month" question; older rows are never shown.
  { name: 'notifications', table: 'ops.notifications', column: 'created_at', days: 90 },
  // Delivered outbox rows only — `sent_at IS NULL` rows (pending or
  // retrying) never match `sent_at < …`, so nothing undelivered is lost.
  { name: 'outbox', table: 'sync.outbox', column: 'sent_at', days: 30 },
  // Client telemetry; forensics for recent incidents only.
  { name: 'client_logs', table: 'ops.client_logs', column: 'created_at', days: 30 },
];

export const RETENTION_BATCH_SIZE = 5_000;
export const RETENTION_MAX_BATCHES = 40;

const IDENT = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

/** One batch: delete at most `limit` expired rows, returning their ids. */
export function retentionDeleteSql(rule: RetentionRule, limit: number): SQL {
  if (!IDENT.test(rule.table) || !IDENT.test(rule.column)) {
    throw new Error(`retention: invalid identifier in rule ${rule.name}`);
  }
  if (!Number.isInteger(rule.days) || rule.days <= 0) {
    throw new Error(`retention: days must be a positive integer (${rule.name})`);
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`retention: limit must be a positive integer (${rule.name})`);
  }
  const table = sql.raw(rule.table);
  const column = sql.raw(rule.column);
  return sql`
    DELETE FROM ${table}
    WHERE id IN (
      SELECT id FROM ${table}
      WHERE ${column} < NOW() - (${rule.days}::int * interval '1 day')
      LIMIT ${limit}::int
    )
    RETURNING id
  `;
}

/**
 * Call `deleteBatch` until it returns fewer than `batchSize` rows (the
 * table is clean) or `maxBatches` is reached. Each call is expected to
 * be its own transaction. Returns the total deleted.
 */
export async function deleteInBatches(
  deleteBatch: (limit: number) => Promise<number>,
  batchSize = RETENTION_BATCH_SIZE,
  maxBatches = RETENTION_MAX_BATCHES,
): Promise<{ deleted: number; batches: number; exhausted: boolean }> {
  let deleted = 0;
  let batches = 0;
  while (batches < maxBatches) {
    const n = await deleteBatch(batchSize);
    batches += 1;
    deleted += n;
    if (n < batchSize) return { deleted, batches, exhausted: false };
  }
  // Hit the cap with full batches: there is (probably) more to delete.
  return { deleted, batches, exhausted: true };
}
