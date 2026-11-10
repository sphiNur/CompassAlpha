/**
 * D1 / R2-HIS-1 / R2-ENG-2 (2026-10-31): money lines are rounded half-up
 * to cents once, and every view adds those cents.
 *
 * A run with half-cent lines (0.5 kg × 2.01 = 1.005) used to read
 * differently on every surface: the frozen RunFinished total said .02,
 * the report .03, a store group .50 against a headline .51. Now the
 * frozen totals, run.get, run.list, run.history (rows, store totals,
 * summary), report.totals and the sum of report.purchaseLines are the
 * same strings.
 *
 * PG-gated (DATABASE_URL set and SKIP_PG_TESTS !== '1').
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb, schema as s } from '@compass/db';
import { type ActorCtx, type RunCommand } from '@compass/domain/run';
import { sumMoney } from '@compass/contracts';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor } from './helpers/ctx';
import { runStream } from './helpers/streams';
import { seedOwnedOrg } from './helpers/fixtures';

describe('run money rounding (PG, D1)', () => {
  test.skipIf(!SHOULD_RUN)(
    'half-cent lines: every view shows the same cents',
    async () => {
      const db = getDb(undefined, { system: 'maintenance' });
      const { orgId, slug, session } = await seedOwnedOrg(db, 'Money Rounding');
      const [storeA] = await db
        .insert(s.stores)
        .values({ orgId, name: 'A', code: `A-${slug.slice(-6)}` })
        .returning();
      const [storeB] = await db
        .insert(s.stores)
        .values({ orgId, name: 'B', code: `B-${slug.slice(-6)}` })
        .returning();
      const skus = [];
      for (const code of ['CHK', 'BTR', 'SLT']) {
        const [sku] = await db
          .insert(s.skus)
          .values({
            orgId,
            code: `${code}-${slug.slice(-6)}`,
            names: { en: code },
            unit: 'kg',
            step: '0.5',
          })
          .returning();
        skus.push(sku!);
      }
      if (!storeA || !storeB) throw new Error('fixture insert failed');

      const actor: ActorCtx = {
        userId: session.userId,
        memberId: session.memberId,
        permissions: session.permissions,
      };
      const runId = randomUUID();
      const runLog = runStream(orgId, runId);
      const exec = (cmd: RunCommand) => runLog.exec(cmd);
      await exec({
        type: 'PlanRun',
        orgId,
        runDate: '2026-10-21',
        runIndex: 0,
        sessionIds: [randomUUID()],
        plannedItems: skus.map((sku) => ({ skuId: sku.id, qty: '1' })),
        actor,
      });
      await exec({ type: 'StartPurchase', actor });
      // The report's own reproduction: 0.5 × 2.01, 0.5 × 4.03, 0.5 × 0.01
      // per store, one store paying the butter by transfer.
      const prices = ['2.01', '4.03', '0.01'];
      for (const [i, sku] of skus.entries()) {
        await exec({
          type: 'PurchaseItem',
          skuId: sku.id,
          supplierId: null,
          unitPrice: prices[i]!,
          actualQty: '1',
          receiptPhotoUrl: null,
          storeSplits: [
            { storeId: storeA.id, qty: '0.5' },
            i === 1
              ? { storeId: storeB.id, qty: '0.5', paymentMethod: 'transfer' as const }
              : { storeId: storeB.id, qty: '0.5' },
          ],
          paymentMethod: 'cash',
          actor,
        });
      }
      await exec({
        type: 'AddRunExpense',
        expenseId: randomUUID(),
        label: 'porter',
        qty: '1',
        unitPrice: '2.01',
        storeSplits: [
          { storeId: storeA.id, qty: '0.5' },
          { storeId: storeB.id, qty: '0.5' },
        ],
        paymentMethod: 'cash',
        receiptPhotoUrl: null,
        reason: 'carry',
        actor,
      });

      const caller = callerFor(session);
      // run.get while buying: the finish sheet's three numbers.
      const live = await caller.run.get({ runId });
      // Per store: 1.01 + 2.02 + 0.01 = 3.04 items, 1.01 expense.
      expect(live.money).toEqual({ itemsTotal: '6.08', expensesTotal: '2.02', total: '8.10' });

      await exec({ type: 'StartDelivery', actor });
      for (const storeId of [storeA.id, storeB.id]) {
        await exec({ type: 'DeliverToStore', storeId, actor });
        for (const sku of skus) {
          await exec({
            type: 'ConfirmStoreItem',
            storeId,
            skuId: sku.id,
            status: 'ok',
            note: null,
            photoUrl: null,
            actor,
          });
        }
        await exec({ type: 'ConfirmStore', storeId, actor });
      }
      const finished = (await exec({ type: 'FinishRun', actor }))[0];
      if (finished?.type !== 'RunFinished') throw new Error('expected RunFinished');
      expect(finished.payload.itemsTotal).toBe('6.08');
      expect(finished.payload.expensesTotal).toBe('2.02');
      // Items only: B's butter line by transfer, the rest cash.
      expect(finished.payload.totalTransfer).toBe('2.02');
      expect(finished.payload.totalCash).toBe('4.06');

      const range = { startDate: '2026-10-21', endDate: '2026-10-21' };
      const totals = await caller.report.totals(range);
      const lines = await caller.report.purchaseLines(range);
      const history = await caller.run.history({ dateFrom: range.startDate, dateTo: range.endDate });
      const list = await caller.run.list();
      const row = history.rows.find((r) => r.id === runId)!;
      const listed = list.find((r) => r.id === runId)!;

      expect(totals).toMatchObject({
        total: '8.10',
        itemsTotal: '6.08',
        expensesTotal: '2.02',
        totalTransfer: '2.02',
        totalCash: '6.08',
      });
      expect(lines.map((l) => l.lineTotal).sort()).toEqual(
        ['0.01', '0.01', '1.01', '1.01', '1.01', '1.01', '2.02', '2.02'].sort(),
      );
      expect(sumMoney(lines.map((l) => l.lineTotal))).toBe(totals.total as string);
      expect(row).toMatchObject({
        actualTotal: '8.10',
        itemsTotal: '6.08',
        expensesTotal: '2.02',
        actualCashTotal: '6.08',
        actualTransferTotal: '2.02',
      });
      expect(history.summary).toMatchObject({ total: '8.10', cash: '6.08', transfer: '2.02' });
      expect(row.storeTotals.map((st) => st.total)).toEqual(['4.05', '4.05']);
      expect(sumMoney(row.storeTotals.map((st) => st.total))).toBe(row.actualTotal);
      expect(listed.money).toEqual({ itemsTotal: '6.08', expensesTotal: '2.02', total: '8.10' });
      expect(sumMoney(listed.storeTotals.map((st) => st.total))).toBe('8.10');
    },
  );
});
