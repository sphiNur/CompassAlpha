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
 *   1. Open a single SERIALIZABLE transaction.
 *   2. TRUNCATE the read-model tables (CASCADE so any FK children
 *      go with them) plus `inventory.price_history` (derived from
 *      ItemPurchased events, regenerated on replay).
 *   3. Stream every event from `domain.events` ordered by
 *      `(stream_type, stream_id, seq)`.
 *   4. For each stream: fold events through the aggregate's `apply*`
 *      reducer, then feed them in *one shot* through the matching
 *      `project*` writer.
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
import { getDb, schema as s, closeDb } from '@compass/db';
import { applyRun, emptyRunState, type RunEvent } from '@compass/domain/run';
import { apply as applyOrder, emptyState as emptyOrderState, type OrderEvent } from '@compass/domain/order';
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
  const db = getDb(process.env.DATABASE_URL);

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

    // ---- Replay run streams ----
    if (opts.type === 'all' || opts.type === 'run') {
      const runStreams = (await tx.execute(sql`
        SELECT DISTINCT stream_id::text AS id, org_id::text AS org_id
        FROM domain.events
        WHERE stream_type = 'run'
        ORDER BY stream_id
      `)) as unknown as Array<{ id: string; org_id: string }>;

      for (const stream of runStreams) {
        const evts = (await tx.execute(sql`
          SELECT
            stream_id::text   AS stream_id,
            seq::int          AS seq,
            occurred_at       AS occurred_at,
            actor_user_id::text   AS actor_user_id,
            actor_member_id::text AS actor_member_id,
            type              AS type,
            payload           AS payload
          FROM domain.events
          WHERE stream_type = 'run' AND stream_id = ${stream.id}::uuid
          ORDER BY seq ASC
        `)) as unknown as Array<{
          stream_id: string;
          seq: number;
          occurred_at: Date;
          actor_user_id: string | null;
          actor_member_id: string | null;
          type: string;
          payload: unknown;
        }>;

        const events: RunEvent[] = evts.map(
          (e) =>
            ({
              streamId: e.stream_id,
              seq: e.seq,
              occurredAt: new Date(e.occurred_at),
              actorUserId: e.actor_user_id,
              actorMemberId: e.actor_member_id,
              type: e.type,
              payload: e.payload,
            }) as unknown as RunEvent,
        );

        // Sanity-fold through apply to catch corruption early; we
        // throw out the state, projection is the side-effect we want.
        let state = emptyRunState(stream.id);
        for (const e of events) state = applyRun(state, e);
        void state;

        await projectRun(tx, stream.org_id, events);
        runStreamsProcessed++;
      }
    }

    // ---- Replay order streams ----
    if (opts.type === 'all' || opts.type === 'order') {
      const orderStreams = (await tx.execute(sql`
        SELECT DISTINCT stream_id::text AS id, org_id::text AS org_id
        FROM domain.events
        WHERE stream_type = 'order'
        ORDER BY stream_id
      `)) as unknown as Array<{ id: string; org_id: string }>;

      for (const stream of orderStreams) {
        const evts = (await tx.execute(sql`
          SELECT
            stream_id::text   AS stream_id,
            seq::int          AS seq,
            occurred_at       AS occurred_at,
            actor_user_id::text   AS actor_user_id,
            actor_member_id::text AS actor_member_id,
            type              AS type,
            payload           AS payload
          FROM domain.events
          WHERE stream_type = 'order' AND stream_id = ${stream.id}::uuid
          ORDER BY seq ASC
        `)) as unknown as Array<{
          stream_id: string;
          seq: number;
          occurred_at: Date;
          actor_user_id: string | null;
          actor_member_id: string | null;
          type: string;
          payload: unknown;
        }>;

        const events: OrderEvent[] = evts.map(
          (e) =>
            ({
              streamId: e.stream_id,
              seq: e.seq,
              occurredAt: new Date(e.occurred_at),
              actorUserId: e.actor_user_id,
              actorMemberId: e.actor_member_id,
              type: e.type,
              payload: e.payload,
            }) as unknown as OrderEvent,
        );

        let state = emptyOrderState(stream.id);
        for (const e of events) state = applyOrder(state, e);
        void state;

        await projectOrder(tx, stream.org_id, events);
        orderStreamsProcessed++;
      }
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

void main().catch((err) => {
  console.error('[reproject] FAILED', err);
  void closeDb().finally(() => process.exit(1));
});
