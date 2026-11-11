/**
 * 2026-10-21 CA-11 / CA-06 / CA-04 regression tests.
 *
 *  - CA-11: one purchase-money definition. report.totals must equal the
 *    run.history totals for a run with a per-store price override AND an
 *    off-catalog expense, and both must equal the domain's frozen
 *    itemsTotal + expensesTotal.
 *  - CA-06: a store that confirms a 'short' line books the received qty
 *    into inventory, not the split qty (pure helper + PG projection).
 *  - CA-04: a second run can be created while the first is delivering,
 *    through run.create; the database refuses a second planned or
 *    purchasing run by its partial unique index.
 *
 * PG-gated (DATABASE_URL set and SKIP_PG_TESTS !== '1'); the pure
 * receivedDelta cases always run.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb, schema as s } from '@compass/db';
import { type ActorCtx, type RunCommand } from '@compass/domain/run';
import { receivedDelta } from '../services/runProjection';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor } from './helpers/ctx';
import { runStream } from './helpers/streams';
import { seedOwnedOrg } from './helpers/fixtures';
import { pgErrorOf } from './helpers/errors';
import { cleanUpAfterAll } from './helpers/cleanup';

cleanUpAfterAll();

describe('receivedDelta (CA-06)', () => {
  test('ok / undecided / legacy lines book the full split', () => {
    expect(receivedDelta({ qty: '4.000', confirmStatus: 'ok', confirmReceivedQty: null })).toBe(
      '4.000',
    );
    expect(receivedDelta({ qty: '4.000', confirmStatus: null, confirmReceivedQty: null })).toBe(
      '4.000',
    );
    // Legacy 'short' event recorded before receivedQty existed.
    expect(receivedDelta({ qty: '4.000', confirmStatus: 'short', confirmReceivedQty: null })).toBe(
      '4.000',
    );
  });

  test('problem lines with a received qty book that qty', () => {
    expect(
      receivedDelta({ qty: '4.000', confirmStatus: 'short', confirmReceivedQty: '1.500' }),
    ).toBe('1.500');
    expect(receivedDelta({ qty: '4.000', confirmStatus: 'wrong', confirmReceivedQty: '0' })).toBe(
      '0',
    );
  });

  test('DX-DLV-01: quantity a correction added is received on a problem line too', () => {
    expect(
      receivedDelta({ qty: '12.000', confirmStatus: 'short', confirmReceivedQty: '5.000' }, '2'),
    ).toBe('7');
    // ok lines already book the whole (grown) split.
    expect(receivedDelta({ qty: '12.000', confirmStatus: 'ok', confirmReceivedQty: null }, '2')).toBe(
      '12.000',
    );
  });
});

/** A new organisation whose owner does the buying. */
async function buyerOrg(name: string) {
  const db = getDb(undefined, { system: 'maintenance' });
  const { orgId, slug, session } = await seedOwnedOrg(db, name);
  const actor: ActorCtx = {
    userId: session.userId,
    memberId: session.memberId,
    permissions: session.permissions,
  };
  return { db, orgId, slug, actor, caller: callerFor(session) };
}

describe('run money consistency (PG)', () => {
  test.skipIf(!SHOULD_RUN)(
    'report.totals == run.history totals == frozen items + expenses; short line books received qty',
    async () => {
      const { db, orgId, slug, actor, caller } = await buyerOrg('Money Consistency');
      const [storeA] = await db
        .insert(s.stores)
        .values({ orgId, name: 'A', code: `A-${slug.slice(-6)}` })
        .returning();
      const [storeB] = await db
        .insert(s.stores)
        .values({ orgId, name: 'B', code: `B-${slug.slice(-6)}` })
        .returning();
      const [sku] = await db
        .insert(s.skus)
        .values({
          orgId,
          code: `APL-${slug.slice(-6)}`,
          names: { en: 'Apple' },
          unit: 'kg',
          step: '0.5',
        })
        .returning();
      if (!storeA || !storeB || !sku) throw new Error('fixture insert failed');

      const runId = randomUUID();
      const runLog = runStream(orgId, runId);
      const exec = (cmd: RunCommand) => runLog.exec(cmd);

      await exec({
        type: 'PlanRun',
        orgId,
        runDate: '2026-10-20',
        runIndex: 0,
        sessionIds: [randomUUID()],
        plannedItems: [{ skuId: sku.id, qty: '4' }],
        actor,
      });
      await exec({ type: 'StartPurchase', actor });
      // 2 kg @ 12,000 cash to A; 2 kg @ 15,000 (override) transfer to B.
      await exec({
        type: 'PurchaseItem',
        skuId: sku.id,
        supplierId: null,
        unitPrice: '12000',
        actualQty: '4',
        receiptPhotoUrl: null,
        storeSplits: [
          { storeId: storeA.id, qty: '2' },
          { storeId: storeB.id, qty: '2', unitPrice: '15000', paymentMethod: 'transfer' },
        ],
        paymentMethod: 'cash',
        actor,
      });
      await exec({
        type: 'AddRunExpense',
        expenseId: randomUUID(),
        label: 'porter',
        qty: '1',
        unitPrice: '5000',
        storeSplits: [
          { storeId: storeA.id, qty: '0.5' },
          { storeId: storeB.id, qty: '0.5' },
        ],
        paymentMethod: 'cash',
        receiptPhotoUrl: null,
        reason: 'carry',
        actor,
      });
      await exec({ type: 'StartDelivery', actor });
      for (const storeId of [storeA.id, storeB.id]) {
        await exec({ type: 'DeliverToStore', storeId, actor });
      }
      // CA-06: A got 1.5 of its 2 kg.
      await exec({
        type: 'ConfirmStoreItem',
        storeId: storeA.id,
        skuId: sku.id,
        status: 'short',
        note: 'half a kilo missing',
        photoUrl: null,
        receivedQty: '1.5',
        actor,
      });
      // DLV-19: B's line is checked explicitly before B can confirm.
      await exec({
        type: 'ConfirmStoreItem',
        storeId: storeB.id,
        skuId: sku.id,
        status: 'ok',
        note: null,
        photoUrl: null,
        actor,
      });
      for (const storeId of [storeA.id, storeB.id]) {
        await exec({ type: 'ConfirmStore', storeId, actor });
      }
      const finished = (await exec({ type: 'FinishRun', actor }))[0];
      if (finished?.type !== 'RunFinished') throw new Error('expected RunFinished');
      // 2 × 12,000 + 2 × 15,000 = 54,000 items; 5,000 expenses.
      expect(finished.payload.itemsTotal).toBe('54000.00');
      expect(finished.payload.expensesTotal).toBe('5000.00');

      const movements = await db.query.inventoryMovements.findMany({
        where: (m, { eq, and }) => and(eq(m.sourceId, runId), eq(m.skuId, sku.id)),
      });
      const deltaFor = (storeId: string) =>
        Number(movements.find((m) => m.storeId === storeId)?.delta);
      expect(deltaFor(storeA.id)).toBe(1.5);
      expect(deltaFor(storeB.id)).toBe(2);

      const history = await caller.run.history({ dateFrom: '2026-10-20', dateTo: '2026-10-20' });
      const totals = await caller.report.totals({
        startDate: '2026-10-20',
        endDate: '2026-10-20',
      });
      const lines = await caller.report.purchaseLines({
        startDate: '2026-10-20',
        endDate: '2026-10-20',
      });
      const row = history.rows.find((r) => r.id === runId);
      expect(Number(row?.actualTotal)).toBe(59000);
      expect(Number(row?.itemsTotal)).toBe(54000);
      expect(Number(row?.expensesTotal)).toBe(5000);
      expect(Number(totals.total)).toBe(Number(history.summary.total));
      expect(Number(totals.itemsTotal)).toBe(Number(history.summary.itemsTotal));
      expect(Number(totals.expensesTotal)).toBe(Number(history.summary.expensesTotal));
      expect(Number(totals.totalCash)).toBe(Number(history.summary.cash));
      expect(Number(totals.totalTransfer)).toBe(Number(history.summary.transfer));
      expect(lines.reduce((sum, l) => sum + Number(l.lineTotal), 0)).toBe(59000);
      expect(lines.filter((l) => l.kind === 'expense')).toHaveLength(2);
      const storeSum = (row?.storeTotals ?? []).reduce((sum, st) => sum + Number(st.total), 0);
      expect(storeSum).toBe(59000);
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'CA-04: a delivering run does not block a new one; a planned or purchasing one does',
    async () => {
      const { db, orgId, caller } = await buyerOrg('Parallel Runs');
      const base = { orgId, runDate: '2026-10-20' };
      await db
        .insert(s.marketRunsV)
        .values({ ...base, id: randomUUID(), runIndex: 0, status: 'delivering' });
      await db
        .insert(s.marketRunsV)
        .values({ ...base, id: randomUUID(), runIndex: 1, status: 'delivering' });

      // run.create hands back a live run instead of making another. With
      // only delivering runs there is none, so it goes on to the orders it
      // was given (here one that does not exist).
      await expect(caller.run.create({ sessionIds: [randomUUID()] })).rejects.toThrow(
        'run.errors.sessionMissing',
      );

      const buying = randomUUID();
      await db
        .insert(s.marketRunsV)
        .values({ ...base, id: buying, runIndex: 2, status: 'purchasing' });
      expect(await caller.run.create({ sessionIds: [randomUUID()] })).toMatchObject({
        runId: buying,
        reused: true,
      });

      // Underneath, the database refuses a second planned or purchasing run:
      // the partial unique index, not some other failure.
      const refusal = await pgErrorOf(() =>
        db
          .insert(s.marketRunsV)
          .values({ ...base, id: randomUUID(), runIndex: 3, status: 'planned' }),
      );
      expect(refusal).toMatchObject({ code: '23505', constraint: 'mrv_one_active_per_org_unique' });
    },
  );
});
