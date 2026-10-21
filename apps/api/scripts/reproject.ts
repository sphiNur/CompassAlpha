/**
 * Projection rebuild — disaster recovery script (M1.16, 2026-05-08).
 *
 * The system is event-sourced: `domain.events` is the immutable source
 * of truth; every other table that the UI reads is a *projection* of
 * that log. Until M1.16 we had no documented runbook to recover from
 * a corrupted projection — code reviewers (correctly) flagged this
 * as a quiet operational gap.
 *
 * What this script does:
 *
 *   1. Open a single transaction.
 *   2. TRUNCATE the read-model tables (CASCADE so any FK children
 *      go with them) plus `inventory.price_history` (derived from
 *      ItemPurchased events, regenerated on replay).
 *   3. Read every event of a stream type from `domain.events` in the
 *      order it happened across streams (see `replay`).
 *   4. For each event: fold it through its aggregate's `apply*` reducer,
 *      then feed it through the matching `project*` writer.
 *   5. Commit the whole thing. If any step throws, the tx rolls back
 *      and the read model is unchanged — the script is fail-safe by
 *      construction.
 *
 * What this script does NOT touch:
 *
 *   - `domain.events` (source of truth — never modified)
 *   - `domain.policy_decisions` (separate audit log, not a projection)
 *   - `ops.notifications` / `ops.audit_log` (written by routers, not
 *     by projections — replaying would NOT regenerate them, by design;
 *     the user-facing inbox is intentionally a separate log)
 *   - `sync.outbox` (worker state — replaying would re-fire bot
 *     messages, which we don't want)
 *   - `auth.*`, `inventory.{stores,suppliers,categories,skus,...}`
 *     (catalog tables aren't event-sourced; nothing to rebuild)
 *
 * Usage:
 *
 *   # From repo root, after `pnpm install`:
 *   pnpm --filter @compass/api reproject
 *
 *   # Or directly:
 *   bun apps/api/scripts/reproject.ts
 *
 *   # Optional: limit to one stream type for targeted recovery:
 *   bun apps/api/scripts/reproject.ts --type=run
 *   bun apps/api/scripts/reproject.ts --type=order
 *
 * Safety:
 *
 *   - The script REFUSES to run if `domain.events` is empty (probably
 *     wrong DB).
 *   - Prints a confirmation prompt with the row counts about to be
 *     truncated; needs `--yes` to skip (for CI / automation).
 *   - Idempotent: running it twice produces the same final state.
 *   - Time bounds: ~50 ms per 1000 events on a warm DB connection.
 */
import { sql } from 'drizzle-orm';
import { getDb, schema as s, closeDb, type DB } from '@compass/db';
import { applyRun, emptyRunState, type RunEvent } from '@compass/domain/run';
import {
  apply as applyOrder,
  emptyState as emptyOrderState,
  type OrderEvent,
} from '@compass/domain/order';
import { projectRun } from '../src/services/runProjection';
import { projectOrder } from '../src/services/orderProjection';

type StreamType = 'run' | 'order';

interface Options {
  type: StreamType | 'all';
  yes: boolean;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  let type: Options['type'] = 'all';
  let yes = false;
  for (const a of args) {
    if (a === '--yes' || a === '-y') yes = true;
    else if (a === '--type=run') type = 'run';
    else if (a === '--type=order') type = 'order';
    else if (a === '--type=all') type = 'all';
    else if (a.startsWith('--')) {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return { type, yes };
}

async function confirm(prompt: string): Promise<boolean> {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    process.stdin.setEncoding('utf-8');
    process.stdin.once('data', (data) => {
      const answer = data.toString().trim().toLowerCase();
      resolve(answer === 'y' || answer === 'yes');
    });
  });
}

async function main() {
  const opts = parseArgs();
  // 2026-10-21 audit CA-14: operator script reads and writes every org, so
  // open the pool in the system context; under fail-closed RLS a plain
  // handle sees zero rows (reproject would refuse, repair would say "clean").
  const db = getDb(process.env.DATABASE_URL, { system: 'maintenance' });

  // Sanity check: refuse to run on an empty event log. Catches the
  // "you ran this against the wrong DB" footgun, where TRUNCATE-then-
  // replay-nothing wipes the read model entirely.
  const eventCountRow = (await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM domain.events`,
  )) as unknown as Array<{ n: number }>;
  const totalEvents = eventCountRow[0]?.n ?? 0;
  if (totalEvents === 0) {
    console.error(
      '[reproject] domain.events is empty — refusing to truncate read model. ' +
        'Did you point DATABASE_URL at the right DB?',
    );
    process.exit(3);
  }

  // Count current read-model rows so the operator knows what's about
  // to disappear if they say yes.
  const counts = (await db.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM read_model.order_sessions_v) AS order_sessions,
      (SELECT COUNT(*)::int FROM read_model.order_items_v)    AS order_items,
      (SELECT COUNT(*)::int FROM read_model.market_runs_v)    AS runs,
      (SELECT COUNT(*)::int FROM read_model.run_items_v)      AS run_items,
      (SELECT COUNT(*)::int FROM read_model.run_item_stores_v) AS run_item_stores,
      (SELECT COUNT(*)::int FROM inventory.price_history)     AS price_history
  `)) as unknown as Array<Record<string, number>>;
  const c = counts[0] ?? {};

  console.log('[reproject] about to truncate and rebuild:');
  console.log(`  scope: ${opts.type}`);
  console.log(`  events in log: ${totalEvents}`);
  for (const [k, v] of Object.entries(c)) {
    console.log(`  ${k.padEnd(20)} ${v} rows`);
  }

  if (!opts.yes) {
    const ok = await confirm('[reproject] type "yes" to continue: ');
    if (!ok) {
      console.log('[reproject] aborted');
      process.exit(1);
    }
  }

  const t0 = Date.now();
  let runStreamsProcessed = 0;
  let orderStreamsProcessed = 0;

  // Single tx so a mid-replay failure rolls back cleanly.
  await db.transaction(async (tx) => {
    // Truncate in dependency order. CASCADE on the parents wipes child
    // tables (run_items_v / run_item_stores_v hang off market_runs_v).
    // M1.14 added actual_cash_total / actual_transfer_total columns to
    // market_runs_v — TRUNCATE preserves the schema, only data goes.
    if (opts.type === 'all' || opts.type === 'run') {
      await tx.execute(sql`TRUNCATE
        read_model.market_runs_v,
        read_model.run_items_v,
        read_model.run_item_stores_v
        CASCADE`);
    }
    if (opts.type === 'all' || opts.type === 'order') {
      await tx.execute(sql`TRUNCATE
        read_model.order_sessions_v,
        read_model.order_items_v
        CASCADE`);
    }
    // price_history is regenerated by run projection (ItemPurchased /
    // PurchaseRevised events insert rows). Only truncate when we're
    // rebuilding runs.
    if (opts.type === 'all' || opts.type === 'run') {
      await tx.execute(sql`TRUNCATE inventory.price_history CASCADE`);
    }

    if (opts.type === 'all' || opts.type === 'run') {
      runStreamsProcessed = await replay<RunEvent, ReturnType<typeof emptyRunState>>(tx, {
        streamType: 'run',
        empty: emptyRunState,
        apply: applyRun,
        project: projectRun,
      });
    }
    if (opts.type === 'all' || opts.type === 'order') {
      orderStreamsProcessed = await replay<OrderEvent, ReturnType<typeof emptyOrderState>>(tx, {
        streamType: 'order',
        empty: emptyOrderState,
        apply: applyOrder,
        project: projectOrder,
      });
    }
  });

  // Suppress unused-symbol warning if a section gets disabled in a future revision.
  void s;

  const elapsedMs = Date.now() - t0;
  console.log(
    `[reproject] done in ${elapsedMs} ms — ` +
      `runs=${runStreamsProcessed} orders=${orderStreamsProcessed}`,
  );
  await closeDb();
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

/**
 * Replay every event of one stream type in the order it happened ACROSS
 * streams, one event at a time.
 *
 * Replaying stream by stream cannot work: the read model carries
 * invariants that span streams ("one active run per org", "one draft
 * per member, store and day", "(org, date, index) is unique"), and a
 * history is only valid in the order it was written. A run that was
 * finished, then reopened while the next day's run was already planned,
 * is two `planned` rows at once if its stream is replayed in one go; the
 * projector's conflict-tolerant insert then drops the run row and the
 * item rows fail their foreign key.
 *
 * There is no global sequence on domain.events, so `occurred_at` is the
 * clock. A stream's own order always wins: each event sorts by the
 * latest `occurred_at` seen so far in its stream, which can never place
 * seq N+1 ahead of seq N even if a clock stepped backwards.
 */
async function replay<E extends { streamId: string }, S>(
  tx: Tx,
  cfg: {
    streamType: 'run' | 'order';
    empty: (streamId: string) => S;
    apply: (state: S, event: E) => S;
    project: (db: DB, orgId: string, events: E[]) => Promise<void>;
  },
): Promise<number> {
  const rows = (await tx.execute(sql`
    SELECT
      stream_id::text   AS stream_id,
      org_id::text      AS org_id,
      seq::int          AS seq,
      occurred_at       AS occurred_at,
      actor_id::text    AS actor_user_id,
      type              AS type,
      payload           AS payload
    FROM (
      SELECT
        e.*,
        MAX(occurred_at) OVER (PARTITION BY stream_id ORDER BY seq) AS replay_at
      FROM domain.events e
      WHERE stream_type = ${cfg.streamType}
    ) ordered
    ORDER BY replay_at, stream_id, seq
  `)) as unknown as Array<{
    stream_id: string;
    org_id: string;
    seq: number;
    occurred_at: Date;
    actor_user_id: string | null;
    type: string;
    payload: unknown;
  }>;

  // Fold through the aggregate as we go: a stream the reducer cannot
  // follow (seq gap, unknown shape) should stop the rebuild, not be
  // projected on a guess.
  const states = new Map<string, S>();
  for (const row of rows) {
    const event = {
      streamId: row.stream_id,
      seq: row.seq,
      occurredAt: new Date(row.occurred_at),
      actorUserId: row.actor_user_id,
      actorMemberId: null,
      type: row.type,
      payload: row.payload,
    } as unknown as E;
    try {
      states.set(
        row.stream_id,
        cfg.apply(states.get(row.stream_id) ?? cfg.empty(row.stream_id), event),
      );
      await cfg.project(tx as unknown as DB, row.org_id, [event]);
    } catch (err) {
      throw new Error(
        `${cfg.streamType} stream ${row.stream_id} seq ${row.seq} (${row.type}) could not be replayed`,
        { cause: err },
      );
    }
  }
  return states.size;
}

void main().catch((err) => {
  console.error('[reproject] FAILED', err);
  void closeDb().finally(() => process.exit(1));
});
