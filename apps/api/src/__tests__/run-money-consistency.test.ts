/**
 * 2026-10-21 CA-11 / CA-06 / CA-04 regression tests.
 *
 *  - CA-11: one purchase-money definition. report.totals must equal the
 *    run.history totals for a run with a per-store price override AND an
 *    off-catalog expense, and both must equal the domain's frozen
 *    itemsTotal + expensesTotal.
 *  - CA-06: a store that confirms a 'short' line books the received qty
 *    into inventory, not the split qty (pure helper + PG projection).
 *  - CA-04: a second run can be created while the first is delivering.
 *
 * PG-gated (DATABASE_URL set and SKIP_PG_TESTS !== '1'); the pure
 * receivedDelta cases always run.
 */
import { describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getDb, schema as s, withOrgContext } from '@compass/db';
import {
  applyRun,
  decideRun,
  emptyRunState,
  type ActorCtx,
  type RunCommand,
  type RunState,
} from '@compass/domain/run';
import { logger } from '../infra/log';
import { appRouter } from '../trpc/router';
import type { RequestContext, SessionContext } from '../trpc/context';
import { appendEvents } from '../services/eventStore';
import { projectRun, receivedDelta } from '../services/runProjection';

(function loadEnv() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate) && existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
      for (const raw of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const idx = line.indexOf('=');
        if (idx < 0) continue;
        const key = line.slice(0, idx).trim();
        const val = line
          .slice(idx + 1)
          .trim()
          .replace(/^"(.*)"$/, '$1');
        if (!(key in process.env)) process.env[key] = val;
      }
      return;
    }
    dir = resolve(dir, '..');
  }
})();

const SHOULD_RUN = !!process.env.DATABASE_URL && process.env.SKIP_PG_TESTS !== '1';

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
});

function buildCtx(db: ReturnType<typeof getDb>, session: SessionContext): RequestContext {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hono: {} as any,
    db,
    log: logger,
    traceId: `test-${Date.now()}`,
    ip: null,
    userAgent: null,
    idempotencyKey: null,
    session,
    async withOrg(fn, options) {
      return withOrgContext(db, session.orgId, fn, options);
    },
  };
}

const PERMS = [
  'users.manage',
  'prices.view',
  'org.admin',
  'run.create',
  'run.create.org',
  'run.purchase',
  'run.finish',
  'delivery.dispatch',
  'delivery.confirm',
];

describe('run money consistency (PG)', () => {
  test.skipIf(!SHOULD_RUN)(
    'report.totals == run.history totals == frozen items + expenses; short line books received qty',
    async () => {
      const db = getDb(undefined, { system: 'maintenance' });
      const slug = `money-${Date.now()}`;
      const [org] = await db
        .insert(s.organizations)
        .values({ slug, name: 'Money Consistency', localeDefault: 'en', timezone: 'UTC' })
        .returning();
      if (!org) throw new Error('org insert failed');
      const [role] = await db
        .insert(s.roles)
        .values({ orgId: org.id, slug: 'super_admin', name: 'SA', rank: 100, isBuiltIn: true })
        .returning();
      for (const key of PERMS) {
        await db
          .insert(s.permissions)
          .values({ key, description: `Test perm ${key}` })
          .onConflictDoNothing();
        await db
          .insert(s.rolePermissions)
          .values({ roleId: role!.id, permissionKey: key })
          .onConflictDoNothing();
      }
      const [user] = await db
        .insert(s.users)
        .values({ displayName: 'Buyer', tgUserId: BigInt(`${Date.now()}71`.slice(-12)) })
        .returning();
      const [member] = await db
        .insert(s.members)
        .values({ orgId: org.id, userId: user!.id, status: 'active' })
        .returning();
      await db.insert(s.memberRoleBindings).values({
        memberId: member!.id,
        roleId: role!.id,
        scopeType: 'global',
      });
      const [storeA] = await db
        .insert(s.stores)
        .values({ orgId: org.id, name: 'A', code: `A-${slug.slice(-6)}` })
        .returning();
      const [storeB] = await db
        .insert(s.stores)
        .values({ orgId: org.id, name: 'B', code: `B-${slug.slice(-6)}` })
        .returning();
      const [sku] = await db
        .insert(s.skus)
        .values({
          orgId: org.id,
          code: `APL-${slug.slice(-6)}`,
          names: { en: 'Apple' },
          unit: 'kg',
          step: '0.5',
        })
        .returning();
      if (!storeA || !storeB || !sku) throw new Error('fixture insert failed');

      const actor: ActorCtx = {
        userId: user!.id,
        memberId: member!.id,
        permissions: new Set(PERMS),
      };
      const runId = randomUUID();
      let state: RunState = emptyRunState(runId);
      const exec = async (cmd: RunCommand) => {
        const evs = decideRun(state, cmd);
        for (const e of evs) state = applyRun(state, e);
        await appendEvents(db, {
          streamType: 'run',
          streamId: runId,
          orgId: org.id,
          events: evs.map((e) => ({ ...e })),
        });
        await projectRun(db, org.id, evs);
        return evs;
      };

      await exec({
        type: 'PlanRun',
        orgId: org.id,
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

      const caller = appRouter.createCaller(
        buildCtx(db, {
          userId: user!.id,
          memberId: member!.id,
          orgId: org.id,
          orgTimezone: 'UTC',
          permissions: new Set(PERMS),
          roleSlugs: new Set(['super_admin']),
        }),
      );
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
    'CA-04: a delivering run no longer blocks the unique index',
    async () => {
      const db = getDb(undefined, { system: 'maintenance' });
      const slug = `parallel-${Date.now()}`;
      const [org] = await db
        .insert(s.organizations)
        .values({ slug, name: 'Parallel Runs', localeDefault: 'en', timezone: 'UTC' })
        .returning();
      const base = { orgId: org!.id, runDate: '2026-10-20' };
      await db
        .insert(s.marketRunsV)
        .values({ ...base, id: randomUUID(), runIndex: 0, status: 'delivering' });
      await db
        .insert(s.marketRunsV)
        .values({ ...base, id: randomUUID(), runIndex: 1, status: 'delivering' });
      await db
        .insert(s.marketRunsV)
        .values({ ...base, id: randomUUID(), runIndex: 2, status: 'purchasing' });
      // A second buying run is still refused.
      let refused = false;
      try {
        await db
          .insert(s.marketRunsV)
          .values({ ...base, id: randomUUID(), runIndex: 3, status: 'planned' });
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
    },
  );
});
