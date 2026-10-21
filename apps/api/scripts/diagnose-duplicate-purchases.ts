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
import { closeDb, getDb, type DB } from '@compass/db';
import type { RunFindings } from '../src/maintenance/duplicatePurchases';
import { hasDamage, loadRunFindings } from '../src/maintenance/loadRunFindings';

async function main(): Promise<void> {
  const jsonAt = process.argv.indexOf('--json');
  const jsonPath = jsonAt === -1 ? null : process.argv[jsonAt + 1];
  if (jsonAt !== -1 && !jsonPath) throw new Error('--json needs a file path');

  // 2026-10-21 audit CA-14: operator script reads every org, so open the
  // pool in the system context; under fail-closed RLS a plain handle (on a
  // non-BYPASSRLS role) sees zero rows and the report would say "clean".
  const db = getDb(process.env.DATABASE_URL, { system: 'maintenance' });
  const report = await db.transaction((tx) => loadRunFindings(tx as unknown as DB), {
    accessMode: 'read only',
  });
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
