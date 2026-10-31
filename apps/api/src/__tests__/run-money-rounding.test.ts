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
import { projectRun } from '../services/runProjection';
import { sumMoney } from '@compass/contracts';

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

describe('run money rounding (PG, D1)', () => {
  test.skipIf(!SHOULD_RUN)(
    'half-cent lines: every view shows the same cents',
    async () => {
      const db = getDb(undefined, { system: 'maintenance' });
      const slug = `cents-${Date.now()}`;
      const [org] = await db
        .insert(s.organizations)
        .values({ slug, name: 'Money Rounding', localeDefault: 'en', timezone: 'UTC' })
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
        .values({ displayName: 'Buyer', tgUserId: BigInt(`${Date.now()}72`.slice(-12)) })
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
      const skus = [];
      for (const code of ['CHK', 'BTR', 'SLT']) {
        const [sku] = await db
          .insert(s.skus)
          .values({
            orgId: org.id,
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
      expect(sumMoney(lines.map((l) => l.lineTotal))).toBe(totals.total);
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
