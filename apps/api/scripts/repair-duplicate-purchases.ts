/**
 * Correct what re-recorded purchases left in the read model.
 *
 *   # 1. What would change. Writes nothing.
 *   bun apps/api/scripts/repair-duplicate-purchases.ts
 *
 *   # 2. Do it. The undo file is mandatory and is written BEFORE any row
 *   #    is touched; the changes commit only if all of them succeed.
 *   bun apps/api/scripts/repair-duplicate-purchases.ts --apply --undo-file d1-undo.json
 *
 *   # 3. Put everything back exactly as it was.
 *   bun apps/api/scripts/repair-duplicate-purchases.ts --revert d1-undo.json
 *
 * Run diagnose-duplicate-purchases.ts first and read its list; this
 * script acts on the same findings (src/maintenance/loadRunFindings.ts).
 *
 * What --apply changes, and nothing else:
 *   - deletes split rows the event history does not support;
 *   - sets a split row's qty to the history's where they differ;
 *   - for each stock receipt a store got for goods it was never sent,
 *     APPENDS a compensating movement (negated delta, reason
 *     'adjustment'). The original movement stays in the ledger.
 *
 * It does not touch domain.events, does not create split rows the
 * history has but the read model lacks (those carry delivery and
 * confirmation state this script cannot reconstruct; they are reported
 * and left for a rebuild), and does not touch price history.
 *
 * Needs a role that can write to read_model and inventory: the app role.
 * Take a database backup before --apply regardless of the undo file.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, getDb, schema as s, type DB } from '@compass/db';
import {
  CORRECTION_SOURCE,
  hasDamage,
  loadRunFindings,
  type LocatedFindings,
} from '../src/maintenance/loadRunFindings';

interface SplitKey {
  runId: string;
  skuId: string;
  storeId: string;
}

interface Plan {
  deleteSplits: SplitKey[];
  setSplitQty: Array<SplitKey & { from: string; to: string }>;
  compensate: Array<SplitKey & { orgId: string; movementId: string; delta: string }>;
  /** Reported only. */
  missingSplits: Array<SplitKey & { qty: string }>;
}

interface UndoFile {
  createdAt: string;
  /** Full rows as they were, so a revert restores delivery/confirm state too. */
  deletedSplits: Array<typeof s.runItemStoresV.$inferSelect>;
  qtyBefore: Array<SplitKey & { qty: string }>;
  /** (run, store, sku) of each compensating movement appended. */
  compensations: SplitKey[];
}

function buildPlan(findings: LocatedFindings[]): Plan {
  const plan: Plan = { deleteSplits: [], setSplitQty: [], compensate: [], missingSplits: [] };
  for (const f of findings.filter(hasDamage)) {
    const at = (r: { skuId: string; storeId: string }): SplitKey => ({
      runId: f.runId,
      skuId: r.skuId,
      storeId: r.storeId,
    });
    for (const r of f.staleSplits) plan.deleteSplits.push(at(r));
    for (const r of f.wrongQtySplits) {
      plan.setSplitQty.push({ ...at(r), from: r.qty, to: r.expectedQty });
    }
    for (const r of f.missingSplits) plan.missingSplits.push({ ...at(r), qty: r.qty });
    for (const m of f.phantomMovements) {
      plan.compensate.push({ ...at(m), orgId: f.orgId, movementId: m.id, delta: m.delta });
    }
  }
  return plan;
}

const splitIs = (k: SplitKey) =>
  and(
    eq(s.runItemStoresV.runId, k.runId),
    eq(s.runItemStoresV.skuId, k.skuId),
    eq(s.runItemStoresV.storeId, k.storeId),
  );

function describe(plan: Plan): void {
  console.log(`Split rows to delete:              ${plan.deleteSplits.length}`);
  console.log(`Split rows to re-quantify:         ${plan.setSplitQty.length}`);
  console.log(`Stock receipts to compensate:      ${plan.compensate.length}`);
  console.log(`Split rows missing (left alone):   ${plan.missingSplits.length}`);
}

async function apply(db: DB, undoPath: string): Promise<void> {
  if (existsSync(undoPath)) {
    throw new Error(`${undoPath} already exists. Refusing to overwrite an undo file.`);
  }
  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const plan = buildPlan((await loadRunFindings(tx)).findings);
    describe(plan);
    if (plan.deleteSplits.length + plan.setSplitQty.length + plan.compensate.length === 0) {
      console.log('\nNothing to repair.');
      return;
    }

    const undo: UndoFile = {
      createdAt: new Date().toISOString(),
      deletedSplits: [],
      qtyBefore: plan.setSplitQty.map((r) => ({
        runId: r.runId,
        skuId: r.skuId,
        storeId: r.storeId,
        qty: r.from,
      })),
      compensations: plan.compensate.map(({ runId, skuId, storeId }) => ({
        runId,
        skuId,
        storeId,
      })),
    };
    for (const key of plan.deleteSplits) {
      undo.deletedSplits.push(...(await tx.select().from(s.runItemStoresV).where(splitIs(key))));
    }
    // On disk before the first write: if the process dies mid-way the
    // transaction rolls back and the file is merely unused.
    writeFileSync(undoPath, JSON.stringify(undo, null, 2));

    for (const key of plan.deleteSplits) {
      await tx.delete(s.runItemStoresV).where(splitIs(key));
    }
    for (const row of plan.setSplitQty) {
      await tx.update(s.runItemStoresV).set({ qty: row.to }).where(splitIs(row));
    }
    for (const c of plan.compensate) {
      await tx.insert(s.inventoryMovements).values({
        orgId: c.orgId,
        storeId: c.storeId,
        skuId: c.skuId,
        delta: sql`-(${c.delta}::numeric)`,
        reason: 'adjustment',
        note: `Reverses movement ${c.movementId}: this store was never sent this item in run ${c.runId}`,
        sourceType: CORRECTION_SOURCE,
        sourceId: c.runId,
      });
    }

    const after = buildPlan((await loadRunFindings(tx)).findings);
    const left = after.deleteSplits.length + after.setSplitQty.length + after.compensate.length;
    if (left > 0) {
      throw new Error(
        `${left} finding(s) remain after the repair — rolling back, nothing changed.`,
      );
    }
    console.log(`\nRepaired. Undo record: ${undoPath}`);
  });
}

async function revert(db: DB, undoPath: string): Promise<void> {
  const undo = JSON.parse(readFileSync(undoPath, 'utf8')) as UndoFile;
  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    for (const row of undo.deletedSplits) {
      await tx
        .insert(s.runItemStoresV)
        .values({
          ...row,
          deliveredAt: row.deliveredAt ? new Date(row.deliveredAt) : null,
          confirmedAt: row.confirmedAt ? new Date(row.confirmedAt) : null,
        })
        .onConflictDoNothing();
    }
    for (const row of undo.qtyBefore) {
      await tx.update(s.runItemStoresV).set({ qty: row.qty }).where(splitIs(row));
    }
    for (const c of undo.compensations) {
      await tx
        .delete(s.inventoryMovements)
        .where(
          and(
            eq(s.inventoryMovements.sourceType, CORRECTION_SOURCE),
            eq(s.inventoryMovements.sourceId, c.runId),
            eq(s.inventoryMovements.storeId, c.storeId),
            eq(s.inventoryMovements.skuId, c.skuId),
          ),
        );
    }
  });
  console.log(
    `Reverted ${undo.deletedSplits.length} split row(s), ${undo.qtyBefore.length} quantity change(s), ` +
      `${undo.compensations.length} compensating movement(s) from ${undoPath} (${undo.createdAt}).`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const valueOf = (flag: string): string | null => {
    const i = args.indexOf(flag);
    if (i === -1) return null;
    const v = args[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`${flag} needs a file path`);
    return v;
  };
  const db = getDb(process.env.DATABASE_URL);
  const revertFrom = valueOf('--revert');
  if (revertFrom) {
    await revert(db, revertFrom);
  } else if (args.includes('--apply')) {
    const undoPath = valueOf('--undo-file');
    if (!undoPath) throw new Error('--apply requires --undo-file <path>');
    await apply(db, undoPath);
  } else {
    const plan = await db.transaction(
      async (tx) => buildPlan((await loadRunFindings(tx as unknown as DB)).findings),
      { accessMode: 'read only' },
    );
    describe(plan);
    console.log('\nDry run: nothing was changed. Re-run with --apply --undo-file <path>.');
  }
  await closeDb();
}

main().catch(async (err) => {
  console.error('[repair] FAILED', err instanceof Error ? err.message : err);
  await closeDb();
  process.exit(1);
});
