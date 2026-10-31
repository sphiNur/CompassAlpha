/**
 * D6 / D10 / D5 (2026-10-31 owner decisions) and the report / sales input
 * checks that came with them:
 *
 *  - D6: nobody without `prices.view` sees money — sales, dish prices,
 *    finance lines and totals, order estimates, approval cards, runs, the
 *    run plan. prices.view is resolved per store (store roles, overrides),
 *    so a member who is staff at A and manager at B sees no money at A
 *    (RE-CLS-2 / RE-HIS-3 / RE-SHL-3).
 *  - D10: migration 0056 gives built-in roles that read reports the
 *    `reports.export` key; custom roles are left alone.
 *  - D5 / HIS-5: History and finance both count finished and amending runs,
 *    nothing still being bought.
 *  - RE-HIS-4: a reversed finance range is refused.
 *  - RE-CLS-6: sales.record takes servings in hundredths.
 *
 * PG-gated: DATABASE_URL set and SKIP_PG_TESTS !== '1'.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema as s, withOrgContext } from '@compass/db';
import { todayInTz } from '@compass/domain';
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
import { loadSession, type RequestContext, type SessionContext } from '../trpc/context';
import { appendEvents } from '../services/eventStore';
import { projectRun } from '../services/runProjection';

const HERE = dirname(fileURLToPath(import.meta.url));
type SeedData = {
  BUILTIN_ROLES: readonly { slug: string; rank: number; permissions: readonly string[] }[];
  ALL_PERMISSION_KEYS: readonly string[];
};
const seedDataPath = resolve(HERE, '../../../../packages/db/src/seed-data.ts');
const { BUILTIN_ROLES, ALL_PERMISSION_KEYS } = (await import(seedDataPath)) as SeedData;

(function loadEnv() {
  let dir = HERE;
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

async function errorOf(
  fn: () => Promise<unknown>,
): Promise<{ code?: string; message: string } | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return { code: (err as { code?: string }).code, message: (err as Error).message };
  }
}

type Caller = ReturnType<typeof appRouter.createCaller>;
type Fixture = {
  db: ReturnType<typeof getDb>;
  orgId: string;
  storeA: string;
  storeB: string;
  skuId: string;
  dishId: string;
  runId: string;
  ownerUserId: string;
  owner: Caller;
  /** Staff at A, manager at B. */
  mixed: Caller;
  mixedMemberId: string;
  /** Custom role with reports.view only, global. */
  accountant: Caller;
  accountantMemberId: string;
  accountantUserId: string;
  roleIds: Record<string, string>;
  exec: (runId: string, cmd: RunCommand) => Promise<unknown[]>;
  actor: ActorCtx;
  person: (bindings: Array<[roleId: string, storeId: string | null]>) => Promise<{
    caller: Caller;
    memberId: string;
    userId: string;
  }>;
  reload: (userId: string, memberId: string) => Promise<Caller>;
};
let fix: Fixture | null = null;

const RUN_DATE = '2026-10-20';

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug: `prices-${suffix}`, name: 'Price visibility', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  const orgId = org!.id;
  const roleIds: Record<string, string> = {};
  for (const slug of ['super_admin', 'manager', 'staff', 'purchaser']) {
    const def = BUILTIN_ROLES.find((r) => r.slug === slug)!;
    const [role] = await db
      .insert(s.roles)
      .values({ orgId, slug, name: slug, rank: def.rank, isBuiltIn: true })
      .returning();
    roleIds[slug] = role!.id;
    for (const key of def.permissions) {
      await db.insert(s.permissions).values({ key, description: key }).onConflictDoNothing();
      await db
        .insert(s.rolePermissions)
        .values({ roleId: role!.id, permissionKey: key })
        .onConflictDoNothing();
    }
  }
  const [accountantRole] = await db
    .insert(s.roles)
    .values({ orgId, slug: 'accountant', name: 'Accountant', rank: 15, isBuiltIn: false })
    .returning();
  roleIds.accountant = accountantRole!.id;
  await db.insert(s.rolePermissions).values({ roleId: accountantRole!.id, permissionKey: 'reports.view' });
  const [plannerRole] = await db
    .insert(s.roles)
    .values({ orgId, slug: 'planner', name: 'Planner', rank: 35, isBuiltIn: false })
    .returning();
  roleIds.planner = plannerRole!.id;
  await db.insert(s.rolePermissions).values({ roleId: plannerRole!.id, permissionKey: 'run.create' });

  const [a] = await db.insert(s.stores).values({ orgId, name: 'A', code: `A-${suffix.slice(-6)}` }).returning();
  const [b] = await db.insert(s.stores).values({ orgId, name: 'B', code: `B-${suffix.slice(-6)}` }).returning();
  const storeA = a!.id;
  const storeB = b!.id;
  const [sku] = await db
    .insert(s.skus)
    .values({ orgId, code: `APL-${suffix.slice(-6)}`, names: { en: 'Apple' }, unit: 'kg', step: '0.5' })
    .returning();
  const skuId = sku!.id;

  let n = 0;
  const reload = async (userId: string, memberId: string) => {
    const session = await loadSession(db, userId, orgId, memberId);
    if (!session) throw new Error('session failed to load');
    return appRouter.createCaller(buildCtx(db, session));
  };
  const person: Fixture['person'] = async (bindings) => {
    n += 1;
    const [u] = await db
      .insert(s.users)
      .values({ displayName: `Prices ${n}`, tgUserId: BigInt(`${suffix}${n}`.slice(-12)) })
      .returning();
    const [m] = await db.insert(s.members).values({ orgId, userId: u!.id, status: 'active' }).returning();
    for (const [roleId, storeId] of bindings) {
      if (storeId) {
        await db
          .insert(s.memberStoreAssignments)
          .values({ memberId: m!.id, storeId, assignedBy: u!.id })
          .onConflictDoNothing();
      }
      await db.insert(s.memberRoleBindings).values({
        memberId: m!.id,
        roleId,
        scopeType: storeId ? 'store' : 'global',
        scopeId: storeId,
      });
    }
    return { caller: await reload(u!.id, m!.id), memberId: m!.id, userId: u!.id };
  };

  const ownerP = await person([[roleIds.super_admin!, null]]);
  const mixedP = await person([
    [roleIds.staff!, storeA],
    [roleIds.manager!, storeB],
  ]);
  const accountantP = await person([[roleIds.accountant!, null]]);

  // A dish with a recipe and a selling price.
  const { dishId } = await ownerP.caller.dishes.save({
    code: `D-${suffix.slice(-6)}`,
    names: { en: 'Pilaf' },
    unitPrice: '35000',
    ingredients: [{ skuId, qtyPerServing: '0.1' }],
  });

  // One finished run serving A and B through real order sessions.
  const actor: ActorCtx = {
    userId: ownerP.userId,
    memberId: ownerP.memberId,
    permissions: new Set(ALL_PERMISSION_KEYS),
  };
  const states = new Map<string, RunState>();
  const exec: Fixture['exec'] = async (runId, cmd) => {
    let state = states.get(runId) ?? emptyRunState(runId);
    const evs = decideRun(state, cmd);
    for (const e of evs) state = applyRun(state, e);
    states.set(runId, state);
    await appendEvents(db, { streamType: 'run', streamId: runId, orgId, events: evs.map((e) => ({ ...e })) });
    await projectRun(db, orgId, evs);
    return evs;
  };
  const runId = randomUUID();
  const sessionIds = [randomUUID(), randomUUID()];
  for (const [i, storeId] of [storeA, storeB].entries()) {
    await db.insert(s.orderSessionsV).values({
      id: sessionIds[i]!,
      orgId,
      storeId,
      initiatedByMemberId: ownerP.memberId,
      orderDate: RUN_DATE,
      status: 'archived',
      runId,
    });
  }
  await exec(runId, {
    type: 'PlanRun',
    orgId,
    runDate: RUN_DATE,
    runIndex: 0,
    sessionIds,
    plannedItems: [{ skuId, qty: '4' }],
    actor,
  });
  await exec(runId, { type: 'StartPurchase', actor });
  await exec(runId, {
    type: 'PurchaseItem',
    skuId,
    supplierId: null,
    unitPrice: '12000',
    actualQty: '4',
    receiptPhotoUrl: null,
    storeSplits: [
      { storeId: storeA, qty: '2' },
      { storeId: storeB, qty: '2' },
    ],
    paymentMethod: 'cash',
    actor,
  });
  await exec(runId, { type: 'StartDelivery', actor });
  for (const storeId of [storeA, storeB]) {
    await exec(runId, { type: 'DeliverToStore', storeId, actor });
    await exec(runId, {
      type: 'ConfirmStoreItem',
      storeId,
      skuId,
      status: 'ok',
      note: null,
      photoUrl: null,
      actor,
    });
    await exec(runId, { type: 'ConfirmStore', storeId, actor });
  }
  await exec(runId, { type: 'FinishRun', actor });

  fix = {
    db,
    orgId,
    storeA,
    storeB,
    skuId,
    dishId,
    runId,
    ownerUserId: ownerP.userId,
    owner: ownerP.caller,
    mixed: mixedP.caller,
    mixedMemberId: mixedP.memberId,
    accountant: accountantP.caller,
    accountantMemberId: accountantP.memberId,
    accountantUserId: accountantP.userId,
    roleIds,
    exec,
    actor,
    person,
    reload,
  };
});

describe.skipIf(!SHOULD_RUN)('D6: money only with prices.view, per store', () => {
  test('sales.list and dishes.list: no selling price where the reader is staff', async () => {
    const { owner, mixed, storeA, storeB, dishId } = fix!;
    await mixed.sales.record({ storeId: storeA, dishId, qty: '1' });
    await mixed.sales.record({ storeId: storeB, dishId, qty: '2' });
    const atA = await mixed.sales.list({ storeId: storeA });
    expect(atA).toHaveLength(1);
    expect(atA[0]!.unitPrice).toBeNull();
    expect(atA[0]!.qty).toBe('1.000');
    const atB = await mixed.sales.list({ storeId: storeB });
    expect(Number(atB[0]!.unitPrice)).toBe(35000);

    const dishAt = async (caller: Caller, storeId?: string) =>
      (await caller.dishes.list(storeId ? { storeId } : undefined)).dishes.find((d) => d.id === dishId)!;
    expect((await dishAt(mixed, storeA)).unitPrice).toBeNull();
    expect(Number((await dishAt(mixed, storeB)).unitPrice)).toBe(35000);
    // No store named: prices.view somewhere is enough (older clients).
    expect(Number((await dishAt(mixed)).unitPrice)).toBe(35000);
    expect(Number((await dishAt(owner, storeA)).unitPrice)).toBe(35000);
  });

  test('run.list / run.get: a run serving a store the reader may not price shows no money', async () => {
    const { owner, mixed, runId } = fix!;
    const ownerRun = await owner.run.get({ runId });
    expect(Number(ownerRun.money.total)).toBe(48000);
    expect(Number(ownerRun.items[0]!.unitPrice)).toBe(12000);

    const mixedRun = await mixed.run.get({ runId });
    expect(mixedRun.money.total).toBeNull();
    expect(mixedRun.actualTotal).toBeNull();
    expect(mixedRun.splits.length).toBeGreaterThan(0);
    expect(mixedRun.splits.every((split) => split.unitPrice === null)).toBe(true);
    expect(mixedRun.items[0]!.unitPrice).toBeNull();
    // Quantities stay.
    expect(mixedRun.splits.map((split) => Number(split.qty))).toEqual([2, 2]);

    const listed = (await mixed.run.list()).find((r) => r.id === runId)!;
    expect(listed.money.total).toBeNull();
    expect(listed.storeTotals.every((st) => st.total === null)).toBe(true);
    const ownerListed = (await owner.run.list()).find((r) => r.id === runId)!;
    expect(Number(ownerListed.money.total)).toBe(48000);
  });

  test('report: lines carry amounts only for priced stores; totals need every store', async () => {
    const { db, accountant, accountantMemberId, accountantUserId, ownerUserId, storeA, storeB, reload } = fix!;
    const range = { startDate: RUN_DATE, endDate: RUN_DATE };
    const lines = await accountant.report.purchaseLines(range);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.unitPrice === null && l.lineTotal === null)).toBe(true);
    expect(lines.map((l) => Number(l.qty))).toEqual([2, 2]);
    const totals = await accountant.report.totals(range);
    expect(totals.total).toBeNull();
    expect(totals.totalCash).toBeNull();
    expect(totals.runCount).toBe(1);
    expect(totals.cashLines).toBe(2);

    // prices.view allowed at B only (store overrides apply where the
    // member is assigned).
    await db
      .insert(s.memberStoreAssignments)
      .values({ memberId: accountantMemberId, storeId: storeB, assignedBy: ownerUserId });
    await db.insert(s.memberPermissionOverrides).values({
      memberId: accountantMemberId,
      permissionKey: 'prices.view',
      effect: 'allow',
      scopeType: 'store',
      scopeId: storeB,
      grantedBy: ownerUserId,
    });
    const partly = await reload(accountantUserId, accountantMemberId);
    const partLines = await partly.report.purchaseLines(range);
    expect(partLines.find((l) => l.storeId === storeA)!.lineTotal).toBeNull();
    expect(Number(partLines.find((l) => l.storeId === storeB)!.lineTotal)).toBe(24000);
    expect((await partly.report.totals(range)).total).toBeNull();
    expect(Number((await partly.report.totals({ ...range, storeId: storeB })).total)).toBe(24000);
  });

  test('order estimates and approval cards follow the store', async () => {
    const { db, orgId, mixed, mixedMemberId, storeA, storeB, skuId } = fix!;
    const today = todayInTz('UTC');
    const sessionAt = async (storeId: string, status: 'draft' | 'submitted') => {
      const id = randomUUID();
      await db.insert(s.orderSessionsV).values({
        id,
        orgId,
        storeId,
        initiatedByMemberId: mixedMemberId,
        orderDate: today,
        status,
        ...(status === 'submitted' ? { submittedAt: new Date(), submittedByMemberId: mixedMemberId } : {}),
      });
      await db.insert(s.orderItemsV).values({ sessionId: id, skuId, contributorMemberId: mixedMemberId, qty: '3' });
      return id;
    };
    await sessionAt(storeA, 'draft');
    const submittedB = await sessionAt(storeB, 'submitted');

    const batchesA = await mixed.order.todayBatches({ storeId: storeA });
    expect(batchesA[0]!.estimatedTotal).toBeNull();
    const batchesB = await mixed.order.todayBatches({ storeId: storeB });
    expect(Number(batchesB[0]!.estimatedTotal)).toBe(36000);

    expect(await mixed.catalog.skuPriceStats({ skuIds: [skuId], storeId: storeA })).toEqual([]);
    expect(await mixed.catalog.skuPriceStats({ skuIds: [skuId], storeId: storeB })).toHaveLength(1);
    expect(await mixed.catalog.skuPriceStats({ skuIds: [skuId] })).toHaveLength(1);

    const card = (await mixed.order.pendingList({})).find((row) => row.id === submittedB)!;
    expect(Number(card.estimatedTotal)).toBe(36000);
    // A store-level deny of prices.view at B takes the amount off B's cards.
    await db.insert(s.memberPermissionOverrides).values({
      memberId: mixedMemberId,
      permissionKey: 'prices.view',
      effect: 'deny',
      scopeType: 'store',
      scopeId: storeB,
      grantedBy: fix!.ownerUserId,
    });
    const denied = (await mixed.order.pendingList({})).find((row) => row.id === submittedB)!;
    expect(denied.estimatedTotal).toBeNull();
    expect(denied.estimatedCash).toBeNull();
    expect(denied.itemCount).toBe(1);
    await db
      .delete(s.memberPermissionOverrides)
      .where(eq(s.memberPermissionOverrides.memberId, mixedMemberId));
  });

  test('run.previewCreatable: a planner without prices.view gets quantities only', async () => {
    const { db, orgId, owner, person, roleIds, storeA, skuId } = fix!;
    const planner = await person([[roleIds.planner!, storeA]]);
    const sessionId = randomUUID();
    await db.insert(s.orderSessionsV).values({
      id: sessionId,
      orgId,
      storeId: storeA,
      initiatedByMemberId: planner.memberId,
      orderDate: todayInTz('UTC'),
      status: 'approved',
    });
    await db.insert(s.orderItemsV).values({ sessionId, skuId, contributorMemberId: planner.memberId, qty: '2' });
    const plan = await planner.caller.run.previewCreatable({});
    expect(plan.plannedItems.find((item) => item.skuId === skuId)?.qty).toBe('2');
    expect(plan.lastPurchasePriceBySku).toEqual({});
    expect(plan.perStoreBudgets).toEqual([]);
    const ownerPlan = await owner.run.previewCreatable({});
    expect(ownerPlan.lastPurchasePriceBySku[skuId]).toBeDefined();
    expect(ownerPlan.perStoreBudgets.length).toBeGreaterThan(0);
    await db.delete(s.orderItemsV).where(eq(s.orderItemsV.sessionId, sessionId));
    await db.delete(s.orderSessionsV).where(eq(s.orderSessionsV.id, sessionId));
  });
});

describe.skipIf(!SHOULD_RUN)('inputs', () => {
  test('RE-HIS-4: a reversed finance range is refused with a key', async () => {
    const { owner } = fix!;
    const bad = { startDate: '2026-10-30', endDate: '2026-10-01' };
    const totals = await errorOf(() => owner.report.totals(bad));
    expect(totals?.code).toBe('BAD_REQUEST');
    expect(totals?.message).toContain('finance.range.invalid');
    const lines = await errorOf(() => owner.report.purchaseLines(bad));
    expect(lines?.code).toBe('BAD_REQUEST');
  });

  test('RE-CLS-6: sales.record takes servings in hundredths', async () => {
    const { owner, storeA, dishId } = fix!;
    for (const qty of ['0.001', '1.005', '0.009']) {
      const err = await errorOf(() => owner.sales.record({ storeId: storeA, dishId, qty }));
      expect(err?.code).toBe('BAD_REQUEST');
      expect(err?.message).toContain('sales.errors.qtyPrecision');
    }
    await expect(owner.sales.record({ storeId: storeA, dishId, qty: '0.01' })).resolves.toBeDefined();
    await expect(owner.sales.record({ storeId: storeA, dishId, qty: '1.50' })).resolves.toBeDefined();
  });
});

describe.skipIf(!SHOULD_RUN)('D5: History and finance count finished and amending runs', () => {
  test('an amending run stays listed and counted; a run being bought counts nowhere', async () => {
    const { owner, exec, actor, runId, orgId, skuId, storeA } = fix!;
    const range = { startDate: RUN_DATE, endDate: RUN_DATE };
    await exec(runId, { type: 'ReopenRun', reason: 'fix a price', actor });
    const history = await owner.run.history({ dateFrom: RUN_DATE, dateTo: RUN_DATE });
    const row = history.rows.find((r) => r.id === runId);
    expect(row?.status).toBe('amending');
    expect(Number(history.summary.total)).toBe(48000);
    const detail = await owner.run.historyDetail({ runId });
    expect(detail.status).toBe('amending');
    expect(detail.canAmend).toBe(false);
    expect(Number((await owner.report.totals(range)).total)).toBe(48000);
    await exec(runId, { type: 'RefinalizeRun', actor });

    // A second run on another day, still purchasing.
    const buying = randomUUID();
    const day = '2026-10-21';
    await exec(buying, {
      type: 'PlanRun',
      orgId,
      runDate: day,
      runIndex: 0,
      sessionIds: [randomUUID()],
      plannedItems: [{ skuId, qty: '1' }],
      actor,
    });
    await exec(buying, { type: 'StartPurchase', actor });
    await exec(buying, {
      type: 'PurchaseItem',
      skuId,
      supplierId: null,
      unitPrice: '10000',
      actualQty: '1',
      receiptPhotoUrl: null,
      storeSplits: [{ storeId: storeA, qty: '1' }],
      paymentMethod: 'cash',
      actor,
    });
    const dayTotals = await owner.report.totals({ startDate: day, endDate: day });
    expect(dayTotals.runCount).toBe(0);
    expect(Number(dayTotals.total)).toBe(0);
    const dayHistory = await owner.run.history({ dateFrom: day, dateTo: day });
    expect(dayHistory.rows).toHaveLength(0);
  });
});

describe.skipIf(!SHOULD_RUN)('D10: migration 0056 (reports.export for built-in report readers)', () => {
  test('built-in roles holding reports.view get reports.export; others do not', async () => {
    const { db, roleIds } = fix!;
    // An organisation created before the key was seeded for managers.
    await db.execute(sql`
      DELETE FROM auth.role_permissions
      WHERE role_id = ${roleIds.manager!}::uuid AND permission_key = 'reports.export'
    `);
    const file = resolve(HERE, '../../../../packages/db/migrations/0056_reports_export_builtin.sql');
    for (const statement of readFileSync(file, 'utf8').split('--> statement-breakpoint')) {
      if (statement.replace(/--.*$/gm, '').trim()) await db.execute(sql.raw(statement));
    }
    const keysOf = async (roleId: string) =>
      (
        await db.query.rolePermissions.findMany({
          where: (rp, { eq: eq2 }) => eq2(rp.roleId, roleId),
        })
      ).map((rp) => rp.permissionKey);
    expect(await keysOf(roleIds.manager!)).toContain('reports.export');
    expect(await keysOf(roleIds.super_admin!)).toContain('reports.export');
    expect(await keysOf(roleIds.staff!)).not.toContain('reports.export');
    // A custom "accountant" keeps exactly what its owner gave it.
    expect(await keysOf(roleIds.accountant!)).toEqual(['reports.view']);
  });
});
