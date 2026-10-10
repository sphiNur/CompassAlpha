/**
 * READ-ONLY report on what re-recorded purchases left in the read model.
 *
 *   bun apps/api/scripts/diagnose-duplicate-purchases.ts
 *   bun apps/api/scripts/diagnose-duplicate-purchases.ts --json report.json
 *
 * It changes nothing: the whole run happens inside a READ ONLY
 * transaction, so a stray write would be refused by Postgres itself.
 * Background and the definition of each finding are in
 * src/maintenance/duplicatePurchases.ts.
 *
 * Point DATABASE_URL at a role that can read every org. On production
 * that is the backup role (BACKUP_DATABASE_URL: SELECT-only, BYPASSRLS):
 *
 *   DATABASE_URL="$BACKUP_DATABASE_URL" bun apps/api/scripts/diagnose-duplicate-purchases.ts
 *
 * What it reports, per run:
 *   - re-recorded purchases (a second ItemPurchased on a bought item);
 *   - split rows the event history does not support, has at another
 *     quantity, or is missing;
 *   - delivery_received stock movements for a store the run never sent
 *     that SKU to.
 *
 * It proposes a correction for each and applies none of them.
 */
import { writeFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '@compass/db';
import type { RunEvent } from '@compass/domain/run';
import {
  analyseRun,
  hasDamage,
  type MovementRow,
  type RunFindings,
  type SplitRow,
} from '../src/maintenance/duplicatePurchases';

type Row = Record<string, unknown>;

function groupBy<T extends Row>(rows: T[], key: string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = String(row[key]);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

async function main(): Promise<void> {
  const jsonAt = process.argv.indexOf('--json');
  const jsonPath = jsonAt === -1 ? null : process.argv[jsonAt + 1];
  if (jsonAt !== -1 && !jsonPath) throw new Error('--json needs a file path');

  const db = getDb(process.env.DATABASE_URL);
  const report = await db.transaction(
    async (tx) => {
      const q = async <T extends Row>(query: ReturnType<typeof sql>): Promise<T[]> =>
        (await tx.execute(query)) as unknown as T[];

      const runs = await q<{ id: string; run_date: string; run_index: number; status: string }>(sql`
        SELECT id::text, run_date::text, run_index, status
        FROM read_model.market_runs_v
        ORDER BY run_date, run_index`);
      const events = groupBy(
        await q(sql`
          SELECT stream_id::text, seq::int, occurred_at, actor_id::text AS actor_user_id, type, payload
          FROM domain.events
          WHERE stream_type = 'run'
          ORDER BY stream_id, seq`),
        'stream_id',
      );
      const splits = groupBy(
        await q(sql`
          SELECT run_id::text, sku_id::text, store_id::text, qty::text
          FROM read_model.run_item_stores_v`),
        'run_id',
      );
      const movements = groupBy(
        await q(sql`
          SELECT id::text, source_id::text AS run_id, sku_id::text, store_id::text, delta::text
          FROM inventory.movements
          WHERE source_type = 'run' AND reason = 'delivery_received'`),
        'run_id',
      );
      const skuNames = new Map(
        (
          await q<{ id: string; label: string }>(sql`
            SELECT id::text, COALESCE(names->>'en', names->>'zh', code, id::text) AS label
            FROM inventory.skus`)
        ).map((r) => [r.id, r.label]),
      );
      const storeNames = new Map(
        (
          await q<{ id: string; name: string }>(sql`SELECT id::text, name FROM inventory.stores`)
        ).map((r) => [r.id, r.name]),
      );

      const findings: Array<RunFindings & { runDate: string; runIndex: number }> = [];
      for (const run of runs) {
        const runEvents = (events.get(run.id) ?? []).map(
          (e) =>
            ({
              streamId: run.id,
              seq: e.seq,
              occurredAt: new Date(e.occurred_at as string),
              actorUserId: e.actor_user_id,
              actorMemberId: null,
              type: e.type,
              payload: e.payload,
            }) as unknown as RunEvent,
        );
        const found = analyseRun(
          run.id,
          runEvents,
          (splits.get(run.id) ?? []).map(
            (r): SplitRow => ({
              skuId: String(r.sku_id),
              storeId: String(r.store_id),
              qty: String(r.qty),
            }),
          ),
          (movements.get(run.id) ?? []).map(
            (r): MovementRow => ({
              id: String(r.id),
              skuId: String(r.sku_id),
              storeId: String(r.store_id),
              delta: String(r.delta),
            }),
          ),
        );
        if (found.rerecorded.length > 0 || hasDamage(found)) {
          findings.push({ ...found, runDate: run.run_date, runIndex: run.run_index });
        }
      }
      return { runsExamined: runs.length, findings, skuNames, storeNames };
    },
    { accessMode: 'read only' },
  );
  await closeDb();

  const { findings, skuNames, storeNames } = report;
  const sku = (id: string) => skuNames.get(id) ?? id;
  const store = (id: string) => storeNames.get(id) ?? id;
  const damaged = findings.filter(hasDamage);
  const count = (pick: (f: RunFindings) => unknown[]) =>
    findings.reduce((n, f) => n + pick(f).length, 0);

  console.log(`Runs examined:                     ${report.runsExamined}`);
  console.log(
    `Runs with a re-recorded purchase:  ${findings.filter((f) => f.rerecorded.length).length}`,
  );
  console.log(`  re-recorded purchases in total:  ${count((f) => f.rerecorded)}`);
  console.log(`Runs whose read model is wrong:    ${damaged.length}`);
  console.log(`  stale split rows:                ${count((f) => f.staleSplits)}`);
  console.log(`  split rows at the wrong qty:     ${count((f) => f.wrongQtySplits)}`);
  console.log(`  split rows missing:              ${count((f) => f.missingSplits)}`);
  console.log(`  phantom stock receipts:          ${count((f) => f.phantomMovements)}`);

  for (const f of damaged) {
    console.log(`\n${f.runDate} #${f.runIndex + 1}  (${f.status})  ${f.runId}`);
    for (const r of f.rerecorded) {
      const dropped = r.droppedStoreIds.map(store).join(', ') || 'no store';
      console.log(`  re-recorded  ${sku(r.skuId)} at seq ${r.seq}, dropping ${dropped}`);
    }
    for (const s of f.staleSplits) {
      console.log(
        `  STALE SPLIT  ${sku(s.skuId)} → ${store(s.storeId)}: ${s.qty} (history has none)`,
      );
    }
    for (const s of f.wrongQtySplits) {
      console.log(
        `  WRONG QTY    ${sku(s.skuId)} → ${store(s.storeId)}: ${s.qty}, history says ${s.expectedQty}`,
      );
    }
    for (const s of f.missingSplits) {
      console.log(`  MISSING      ${sku(s.skuId)} → ${store(s.storeId)}: ${s.qty} has no row`);
    }
    for (const m of f.phantomMovements) {
      console.log(
        `  PHANTOM STOCK ${sku(m.skuId)} → ${store(m.storeId)}: +${m.delta} (movement ${m.id})`,
      );
    }
  }

  if (damaged.length > 0) {
    console.log(`
Proposed correction (NOT applied by this script):
  1. Stale split rows: delete exactly the rows listed above. Wrong-qty
     and missing rows: set / insert the quantity the history gives.
     Run totals and history sums read these rows, so they correct
     themselves. Undo: the --json report holds every row as it was.
  2. Phantom stock receipts: leave the movement in place and append one
     compensating movement per row (same store and SKU, negated delta,
     its own reason and source so it is recognisable and does not
     collide with the original's idempotency key). On-hand stock is
     corrected and the ledger still shows what happened. Undo: delete
     the compensating rows.
  Take a backup first, apply in one transaction, and re-run this report
  afterwards: it should come back clean.`);
  }

  if (jsonPath) {
    writeFileSync(
      jsonPath,
      JSON.stringify({ runsExamined: report.runsExamined, findings }, null, 2),
    );
    console.log(`\nFull findings written to ${jsonPath}`);
  }
}

main().catch(async (err) => {
  console.error('[diagnose] FAILED', err);
  await closeDb();
  process.exit(1);
});
