/**
 * Maintenance purge guards (2026-10-30 operation atlas: CAT-2, CAT-3,
 * CAT-4). Before the fix:
 *   - deleting one order deleted anyone's, though the page promises
 *     real users' orders are never touched;
 *   - reset by date picked orders by order_date and runs by run_date and
 *     left each side pointing at nothing, with no way to delete either;
 *   - any date with a daily close failed with a bare "something went
 *     wrong" (settlement revisions are append-only).
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/purge-guards.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema as s, withOrgContext } from '@compass/db';
import { logger } from '../infra/log';
import { env } from '../env';
import { appRouter } from '../trpc/router';
import { loadSession, type RequestContext, type SessionContext } from '../trpc/context';

const HERE = dirname(fileURLToPath(import.meta.url));
type SeedData = {
  BUILTIN_ROLES: readonly { slug: string; rank: number; permissions: readonly string[] }[];
};
const seedDataPath = resolve(HERE, '../../../../packages/db/src/seed-data.ts');
const { BUILTIN_ROLES } = (await import(seedDataPath)) as SeedData;

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

type Caller = ReturnType<typeof appRouter.createCaller>;
interface Fixture {
  db: ReturnType<typeof getDb>;
  orgId: string;
  storeId: string;
  skuId: string;
  memberId: string;
  admin: Caller;
  staff: Caller;
}
let fix: Fixture | null = null;

async function errorOf(fn: () => Promise<unknown>): Promise<{ code?: string; message: string } | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return { code: (err as { code?: string }).code, message: (err as Error).message };
  }
}

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug: `purge-${suffix}`, name: 'Purge guards', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  const orgId = org!.id;
  const def = BUILTIN_ROLES.find((r) => r.slug === 'staff')!;
  const [staffRole] = await db
    .insert(s.roles)
    .values({ orgId, slug: 'staff', name: 'staff', rank: def.rank, isBuiltIn: true })
    .returning();
  for (const key of def.permissions) {
    await db.insert(s.permissions).values({ key, description: key }).onConflictDoNothing();
    await db.insert(s.rolePermissions).values({ roleId: staffRole!.id, permissionKey: key }).onConflictDoNothing();
  }
  const [store] = await db.insert(s.stores).values({ orgId, name: 'Store', code: `P-${suffix.slice(-6)}` }).returning();
  const [sku] = await db
    .insert(s.skus)
    .values({ orgId, code: `PG-${suffix.slice(-8)}`, names: { en: 'Rice' }, unit: 'kg', step: '1' })
    .returning();

  const user = async (n: number) => {
    const [u] = await db
      .insert(s.users)
      .values({ displayName: `Purge ${n}`, tgUserId: BigInt(`${suffix}${n}`.slice(-12)) })
      .returning();
    const [m] = await db.insert(s.members).values({ orgId, userId: u!.id, status: 'active' }).returning();
    await db.insert(s.memberStoreAssignments).values({ memberId: m!.id, storeId: store!.id, assignedBy: u!.id });
    return { userId: u!.id, memberId: m!.id };
  };
  const a = await user(1);
  const admin = appRouter.createCaller(
    buildCtx(db, {
      userId: a.userId,
      memberId: a.memberId,
      orgId,
      orgTimezone: 'UTC',
      permissions: new Set(['users.manage', 'org.admin', ...def.permissions]),
      roleSlugs: new Set(['super_admin']),
    }),
  );
  const b = await user(2);
  await db
    .insert(s.memberRoleBindings)
    .values({ memberId: b.memberId, roleId: staffRole!.id, scopeType: 'store', scopeId: store!.id });
  const staffSession = await loadSession(db, b.userId, orgId, b.memberId);
  if (!staffSession) throw new Error('session failed to load');
  const staff = appRouter.createCaller(buildCtx(db, staffSession));
  fix = { db, orgId, storeId: store!.id, skuId: sku!.id, memberId: a.memberId, admin, staff };
});

describe.skipIf(!SHOULD_RUN)('maintenance purge guards (PG-gated)', () => {
  test("CAT-3: deleting one order refuses someone else's; one's own test order goes", async () => {
    const { admin, staff, storeId, skuId, db } = fix!;
    const theirs = await staff.order.adjustItem({ storeId, skuId, qty: '2' });
    const err = await errorOf(() => admin.admin.purgeSession({ sessionId: theirs.sessionId, dryRun: false }));
    expect(err?.message).toBe('admin.errors.sessionHasForeignAuthors');
    expect(await db.query.orderSessionsV.findFirst({ where: (x, o) => o.eq(x.id, theirs.sessionId) })).toBeTruthy();

    const mine = { sessionId: randomUUID() };
    await db.insert(s.orderSessionsV).values({
      id: mine.sessionId,
      orgId: fix!.orgId,
      storeId,
      orderDate: '2026-06-20',
      status: 'draft',
      initiatedByMemberId: fix!.memberId,
    });
    expect(await errorOf(() => admin.admin.purgeSession({ sessionId: mine.sessionId, dryRun: false }))).toBeNull();
    expect(await db.query.orderSessionsV.findFirst({ where: (x, o) => o.eq(x.id, mine.sessionId) })).toBeUndefined();
    // CAT-5: the purge is in the admin audit.
    const audit = await db.query.policyDecisions.findFirst({
      where: (x, o) => o.and(o.eq(x.action, 'admin.purge.session'), o.eq(x.resourceId, mine.sessionId)),
    });
    expect(audit).toBeTruthy();
  });

  test('RE-CAT-1: a run someone else worked on cannot be deleted as test data', async () => {
    const { admin, db, orgId } = fix!;
    const [purchaser] = await db
      .insert(s.users)
      .values({ displayName: 'Real buyer', tgUserId: BigInt(`8${Date.now()}`.slice(-12)) })
      .returning();
    const runId = randomUUID();
    await db.insert(s.marketRunsV).values({ id: runId, orgId, runDate: '2026-06-03', status: 'finished' });
    await db.insert(s.events).values({
      orgId,
      streamType: 'run',
      streamId: runId,
      seq: 1,
      type: 'ItemPurchased',
      payload: {},
      actorId: purchaser!.id,
    });
    const err = await errorOf(() =>
      admin.admin.purgeRun({ runId, dryRun: false, requireOnlyTestSessions: true }),
    );
    // R2-CAT-1: the orders are not someone else's; say who did what.
    expect(err?.message).toBe('admin.errors.runActedOnByOthers');
    expect(
      await db.query.marketRunsV.findFirst({ where: (x, o) => o.eq(x.id, runId) }),
    ).toBeTruthy();
  });

  test("R2-CAT-1: one's own order that someone else reviewed is refused with that reason", async () => {
    const { admin, db, orgId, storeId, memberId } = fix!;
    const [approver] = await db
      .insert(s.users)
      .values({ displayName: 'Real approver', tgUserId: BigInt(`7${Date.now()}`.slice(-12)) })
      .returning();
    const sessionId = randomUUID();
    await db.insert(s.orderSessionsV).values({
      id: sessionId,
      orgId,
      storeId,
      orderDate: '2026-06-04',
      status: 'approved',
      initiatedByMemberId: memberId,
      submittedByMemberId: memberId,
    });
    await db.insert(s.events).values({
      orgId,
      streamType: 'order',
      streamId: sessionId,
      seq: 1,
      type: 'Approved',
      payload: {},
      actorId: approver!.id,
    });
    const err = await errorOf(() => admin.admin.purgeSession({ sessionId, dryRun: true }));
    expect(err?.message).toBe('admin.errors.sessionActedOnByOthers');
  });

  test('D2 / R2-CAT-2: on production the guard cannot be waived without the bulk switch', async () => {
    const { admin, db, orgId } = fix!;
    const [buyer] = await db
      .insert(s.users)
      .values({ displayName: 'Waiver buyer', tgUserId: BigInt(`6${Date.now()}`.slice(-12)) })
      .returning();
    const runId = randomUUID();
    await db
      .insert(s.marketRunsV)
      .values({ id: runId, orgId, runDate: '2026-06-06', status: 'finished' });
    await db.insert(s.events).values({
      orgId,
      streamType: 'run',
      streamId: runId,
      seq: 1,
      type: 'ItemPurchased',
      payload: {},
      actorId: buyer!.id,
    });
    const e = env as { NODE_ENV: string; COMPASS_ALLOW_BULK_PURGE?: string };
    const saved = { NODE_ENV: e.NODE_ENV, allow: e.COMPASS_ALLOW_BULK_PURGE };
    try {
      e.NODE_ENV = 'production';
      e.COMPASS_ALLOW_BULK_PURGE = undefined;
      for (const call of [
        () => admin.admin.purgeRun({ runId, dryRun: true, requireOnlyTestSessions: false }),
        () => admin.admin.purgeSession({ sessionId: randomUUID(), requireOnlyTestSessions: false }),
      ]) {
        const err = await errorOf(call);
        expect(err?.code).toBe('FORBIDDEN');
        expect(err?.message).toBe('admin.errors.purgeGuardWaiverDisabledInProduction');
      }
      // With the guard on, the real reason.
      expect((await errorOf(() => admin.admin.purgeRun({ runId, dryRun: true })))?.message).toBe(
        'admin.errors.runActedOnByOthers',
      );
      // The maintenance switch allows the waiver, as for the bulk purges.
      e.COMPASS_ALLOW_BULK_PURGE = 'true';
      expect(
        await errorOf(() =>
          admin.admin.purgeRun({ runId, dryRun: true, requireOnlyTestSessions: false }),
        ),
      ).toBeNull();
      // R2-CAT-3: the page learns whether to offer the bulk purges.
      expect((await admin.system.appConfig()).bulkPurgeAllowed).toBe(true);
      e.COMPASS_ALLOW_BULK_PURGE = undefined;
      expect((await admin.system.appConfig()).bulkPurgeAllowed).toBe(false);
    } finally {
      e.NODE_ENV = saved.NODE_ENV;
      e.COMPASS_ALLOW_BULK_PURGE = saved.allow;
    }
    expect((await admin.system.appConfig()).bulkPurgeAllowed).toBe(true);
  });

  test('RE-CAT-4: the date and workspace previews count run expenses', async () => {
    const { admin, db, orgId, memberId } = fix!;
    const runId = randomUUID();
    await db
      .insert(s.marketRunsV)
      .values({ id: runId, orgId, runDate: '2026-06-07', status: 'finished' });
    await db.insert(s.runExpensesV).values({
      id: randomUUID(),
      runId,
      orgId,
      label: 'Taxi',
      unitPrice: '10000',
      storeSplitsJson: [],
      reason: 'test',
      addedByMemberId: memberId,
      addedAt: new Date(),
    });
    const byDate = await admin.admin.purgeByDate({ date: '2026-06-07', dryRun: true });
    expect(byDate.byTable['read_model.run_expenses_v']).toBe(1);
    const all = await admin.admin.purgeAllTestData({ dryRun: true });
    expect(all.byTable['read_model.run_expenses_v']).toBeGreaterThanOrEqual(1);
  });

  test('D1: the purges still delete the events of what they purge', async () => {
    // The event store refuses DELETE (migration 0055) unless the
    // transaction calls allowEventPurge; each purge path does.
    const { admin, db, orgId, storeId } = fix!;
    const event = (streamType: 'order' | 'run', streamId: string) => ({
      orgId,
      streamType,
      streamId,
      seq: 1,
      type: streamType === 'order' ? 'DraftStarted' : 'RunPlanned',
      payload: {},
    });
    const eventsOf = async (streamId: string) =>
      (await db.select({ id: s.events.id }).from(s.events).where(eq(s.events.streamId, streamId))).length;

    const sessionId = randomUUID();
    await db.insert(s.orderSessionsV).values({ id: sessionId, orgId, storeId, orderDate: '2026-06-21', status: 'draft' });
    await db.insert(s.events).values(event('order', sessionId));
    await admin.admin.purgeSession({ sessionId, dryRun: false });
    expect(await eventsOf(sessionId)).toBe(0);

    const runId = randomUUID();
    await db.insert(s.marketRunsV).values({ id: runId, orgId, runDate: '2026-06-22', status: 'finished' });
    await db.insert(s.events).values(event('run', runId));
    await admin.admin.purgeRun({ runId, dryRun: false });
    expect(await eventsOf(runId)).toBe(0);

    const datedRun = randomUUID();
    await db.insert(s.marketRunsV).values({ id: datedRun, orgId, runDate: '2026-06-23', status: 'finished' });
    await db.insert(s.events).values(event('run', datedRun));
    await admin.admin.purgeByDate({ date: '2026-06-23', dryRun: false });
    expect(await eventsOf(datedRun)).toBe(0);
  });

  test('CAT-5: emptying the workspace keeps the admin audit', async () => {
    const { admin, db, orgId } = fix!;
    const before = await db.query.policyDecisions.findMany({ where: (x, o) => o.eq(x.orgId, orgId) });
    expect(before.length).toBeGreaterThan(0);
    const preview = await admin.admin.purgeAllTestData({ dryRun: true });
    expect(preview.byTable['domain.policy_decisions']).toBeUndefined();
    const [org] = await db
      .select({ slug: s.organizations.slug, name: s.organizations.name })
      .from(s.organizations)
      .where(eq(s.organizations.id, orgId));
    // DX-CAT-17: confirmed with the workspace name people can see; a
    // wrong answer (the old hidden "default"-style slug guess) is refused.
    expect(
      (await errorOf(() => admin.admin.purgeAllTestData({ dryRun: false, confirmText: 'default' })))
        ?.message,
    ).toBe('admin.errors.purgeConfirmMismatch');
    // Runs before the CAT-2 test adds a daily close (which blocks this).
    await admin.admin.purgeAllTestData({ dryRun: false, confirmText: ` ${org!.name} ` });
    const after = await db.query.policyDecisions.findMany({ where: (x, o) => o.eq(x.orgId, orgId) });
    expect(after.length).toBe(before.length + 1);
    expect(after.some((r) => r.action === 'admin.purge.all')).toBe(true);
    // An older client still sends the slug; that keeps working.
    expect(
      await errorOf(() => admin.admin.purgeAllTestData({ dryRun: false, confirmText: org!.slug })),
    ).toBeNull();
  });

  test('CAT-4: reset by date takes the run of its orders and the orders of its runs', async () => {
    const { admin, db, orgId, storeId } = fix!;
    const runId = randomUUID();
    const earlyRunId = randomUUID();
    const earlySession = randomUUID();
    const lateSession = randomUUID();
    // Orders of 06-01 bought by a run of 06-02; a run of 06-01 holding an
    // order of 05-31.
    await db.insert(s.marketRunsV).values({ id: runId, orgId, runDate: '2026-06-02', status: 'finished' });
    await db.insert(s.marketRunsV).values({ id: earlyRunId, orgId, runDate: '2026-06-01', status: 'finished' });
    await db.insert(s.orderSessionsV).values({ id: earlySession, orgId, storeId, orderDate: '2026-06-01', status: 'archived', runId });
    await db.insert(s.orderSessionsV).values({ id: lateSession, orgId, storeId, orderDate: '2026-05-31', status: 'archived', runId: earlyRunId });

    const preview = await admin.admin.purgeByDate({ date: '2026-06-01', dryRun: true });
    expect(preview.byTable['read_model.order_sessions_v']).toBe(2);
    expect(preview.byTable['read_model.market_runs_v']).toBe(2);
    await admin.admin.purgeByDate({ date: '2026-06-01', dryRun: false });
    for (const id of [earlySession, lateSession]) {
      expect(await db.query.orderSessionsV.findFirst({ where: (x, o) => o.eq(x.id, id) })).toBeUndefined();
    }
    for (const id of [runId, earlyRunId]) {
      expect(await db.query.marketRunsV.findFirst({ where: (x, o) => o.eq(x.id, id) })).toBeUndefined();
    }
  });

  test('CAT-4: an order whose run is already gone can be deleted on its own', async () => {
    const { admin, db, orgId, storeId, memberId } = fix!;
    const orphan = randomUUID();
    await db.insert(s.orderSessionsV).values({
      id: orphan,
      orgId,
      storeId,
      orderDate: '2026-06-05',
      status: 'archived',
      runId: randomUUID(),
      initiatedByMemberId: memberId,
      submittedByMemberId: memberId,
    });
    expect(await errorOf(() => admin.admin.purgeSession({ sessionId: orphan, dryRun: false }))).toBeNull();
    expect(await db.query.orderSessionsV.findFirst({ where: (x, o) => o.eq(x.id, orphan) })).toBeUndefined();
  });

  test('CAT-2: a date with a daily close says why it cannot be reset', async () => {
    const { admin, db, orgId, storeId, memberId } = fix!;
    const [settlement] = await db
      .insert(s.storeDailySettlements)
      .values({ orgId, storeId, settlementDate: '2026-06-10' })
      .returning();
    await db.insert(s.storeDailySettlementRevisions).values({
      settlementId: settlement!.id,
      orgId,
      storeId,
      settlementDate: '2026-06-10',
      version: 1,
      snapshot: {},
      actorMemberId: memberId,
    });
    const err = await errorOf(() => admin.admin.purgeByDate({ date: '2026-06-10', dryRun: true }));
    expect(err?.code).toBe('PRECONDITION_FAILED');
    expect(err?.message).toBe('admin.errors.purgeHasSettlements');
    expect(await errorOf(() => admin.admin.purgeByDate({ date: '2026-06-11', dryRun: false }))).toBeNull();
  });

  test('D1: on production the workspace-wide purges refuse; per-item deletes still work', async () => {
    const { admin, db, orgId, storeId, memberId } = fix!;
    const e = env as { NODE_ENV: string; COMPASS_ALLOW_BULK_PURGE?: string };
    const saved = { NODE_ENV: e.NODE_ENV, allow: e.COMPASS_ALLOW_BULK_PURGE };
    const sessionId = randomUUID();
    await db.insert(s.orderSessionsV).values({
      id: sessionId,
      orgId,
      storeId,
      orderDate: '2026-06-21',
      status: 'draft',
      initiatedByMemberId: memberId,
    });
    try {
      e.NODE_ENV = 'production';
      e.COMPASS_ALLOW_BULK_PURGE = undefined;
      for (const call of [
        () => admin.admin.purgeAllTestData({ dryRun: true }),
        () => admin.admin.purgeAllTestData({ dryRun: false, confirmText: 'x' }),
        () => admin.admin.purgeByDate({ date: '2026-06-21', dryRun: true }),
        () => admin.admin.purgeByDate({ date: '2026-06-21', dryRun: false }),
      ]) {
        const err = await errorOf(call);
        expect(err?.code).toBe('FORBIDDEN');
        expect(err?.message).toBe('admin.errors.bulkPurgeDisabledInProduction');
      }
      expect(await db.query.orderSessionsV.findFirst({ where: (x, o) => o.eq(x.id, sessionId) })).toBeTruthy();

      // The explicit switch lets them run again.
      e.COMPASS_ALLOW_BULK_PURGE = 'true';
      expect(await errorOf(() => admin.admin.purgeByDate({ date: '2026-06-22', dryRun: true }))).toBeNull();

      // Deleting one's own single order is not a bulk purge.
      e.COMPASS_ALLOW_BULK_PURGE = undefined;
      expect(await errorOf(() => admin.admin.purgeSession({ sessionId, dryRun: false }))).toBeNull();
      expect(await db.query.orderSessionsV.findFirst({ where: (x, o) => o.eq(x.id, sessionId) })).toBeUndefined();
    } finally {
      e.NODE_ENV = saved.NODE_ENV;
      e.COMPASS_ALLOW_BULK_PURGE = saved.allow;
    }
  });
});

describe.skipIf(!SHOULD_RUN)('maintenance list and previews say what they will do (PG-gated)', () => {
  // The lists and the feed read through the admin's read scope; make the
  // fixture admin a workspace admin, as the super admin is in real orgs.
  beforeAll(async () => {
    const { db, orgId, memberId } = fix!;
    await db.insert(s.permissions).values({ key: 'org.admin', description: 'org.admin' }).onConflictDoNothing();
    const [role] = await db
      .insert(s.roles)
      .values({ orgId, slug: 'org-admin-dx', name: 'Admin', rank: 90 })
      .returning();
    await db.insert(s.rolePermissions).values({ roleId: role!.id, permissionKey: 'org.admin' });
    await db
      .insert(s.memberRoleBindings)
      .values({ memberId, roleId: role!.id, scopeType: 'global', scopeId: null });
  });

  test('DX-CAT-3: the lists say per row whether it can be deleted here, and why not', async () => {
    const { admin, staff, db, orgId, storeId, skuId, memberId } = fix!;
    const date = '2026-07-14';
    const theirs = await staff.order.adjustItem({ storeId, skuId, qty: '1' });
    await db
      .update(s.orderSessionsV)
      .set({ orderDate: date })
      .where(eq(s.orderSessionsV.id, theirs.sessionId));
    const mine = randomUUID();
    await db.insert(s.orderSessionsV).values({
      id: mine,
      orgId,
      storeId,
      orderDate: date,
      status: 'submitted',
      initiatedByMemberId: memberId,
      submittedByMemberId: memberId,
    });
    const reviewed = randomUUID();
    await db.insert(s.orderSessionsV).values({
      id: reviewed,
      orgId,
      storeId,
      orderDate: date,
      status: 'approved',
      initiatedByMemberId: memberId,
      submittedByMemberId: memberId,
    });
    const [approver] = await db
      .insert(s.users)
      .values({ displayName: 'List approver', tgUserId: BigInt(`5${Date.now()}`.slice(-12)) })
      .returning();
    await db.insert(s.events).values({
      orgId,
      streamType: 'order',
      streamId: reviewed,
      seq: 1,
      type: 'Approved',
      payload: {},
      actorId: approver!.id,
    });
    const runId = randomUUID();
    const inRun = randomUUID();
    await db.insert(s.marketRunsV).values({ id: runId, orgId, runDate: date, status: 'finished' });
    await db.insert(s.orderSessionsV).values({
      id: inRun,
      orgId,
      storeId,
      orderDate: date,
      status: 'archived',
      runId,
      initiatedByMemberId: memberId,
      submittedByMemberId: memberId,
    });

    const sessions = await admin.admin.sessionList({ date, limit: 50 });
    const block = (id: string) => sessions.find((x) => x.sessionId === id)?.deleteBlock;
    expect(block(theirs.sessionId)).toBe('othersOrder');
    expect(block(mine)).toBeNull();
    expect(block(reviewed)).toBe('actedOnByOthers');
    expect(block(inRun)).toBe('inRun');
    // The list agrees with what the delete itself does.
    expect(await errorOf(() => admin.admin.purgeSession({ sessionId: mine, dryRun: true }))).toBeNull();

    const runs = await admin.admin.runList({ date, limit: 50 });
    expect(runs.find((r) => r.runId === runId)?.deleteBlock).toBeNull();
    await db.insert(s.events).values({
      orgId,
      streamType: 'run',
      streamId: runId,
      seq: 1,
      type: 'ItemPurchased',
      payload: {},
      actorId: approver!.id,
    });
    const after = await admin.admin.runList({ date, limit: 50 });
    expect(after.find((r) => r.runId === runId)?.deleteBlock).toBe('actedOnByOthers');
  });

  test('DX-CAT-5: the date preview lists what goes with it from other dates', async () => {
    const { admin, db, orgId, storeId } = fix!;
    const runId = randomUUID();
    const ownOrder = randomUUID();
    const laterOrder = randomUUID();
    // A run of 07-20 holding an order of 07-20 and one of 07-21.
    await db.insert(s.marketRunsV).values({ id: runId, orgId, runDate: '2026-07-20', status: 'finished' });
    await db.insert(s.orderSessionsV).values({ id: ownOrder, orgId, storeId, orderDate: '2026-07-20', status: 'archived', runId });
    await db.insert(s.orderSessionsV).values({ id: laterOrder, orgId, storeId, orderDate: '2026-07-21', status: 'archived', runId });

    const preview = await admin.admin.purgeByDate({ date: '2026-07-20', dryRun: true });
    expect(preview.scope.sameDay).toEqual({ orders: 1, runs: 1 });
    expect(preview.scope.linkedOrders).toEqual([
      { orderDate: '2026-07-21', storeName: 'Store', count: 1 },
    ]);
    expect(preview.scope.linkedRuns).toEqual([]);

    // Reset the later day instead: the run of 07-20 goes with it.
    const other = await admin.admin.purgeByDate({ date: '2026-07-21', dryRun: true });
    expect(other.scope.sameDay).toEqual({ orders: 1, runs: 0 });
    expect(other.scope.linkedRuns).toEqual([{ runDate: '2026-07-20', runIndex: 0 }]);
    expect(other.scope.linkedOrders).toEqual([
      { orderDate: '2026-07-20', storeName: 'Store', count: 1 },
    ]);
  });

  test('DX-CAT-2: activity events name their product, store and order, in a stable order', async () => {
    const { admin, db, orgId, storeId, skuId } = fix!;
    const sessionId = randomUUID();
    await db.insert(s.orderSessionsV).values({ id: sessionId, orgId, storeId, orderDate: '2026-07-25', status: 'draft' });
    const at = new Date(Date.now() + 60_000);
    for (const seq of [2, 1, 3]) {
      await db.insert(s.events).values({
        orgId,
        streamType: 'order',
        streamId: sessionId,
        seq,
        type: 'ItemAdjusted',
        payload: { skuId, qty: `${seq}.500` },
        occurredAt: at,
      });
    }
    const events = await admin.admin.recentEvents({ limit: 3 });
    expect(events.map((e) => e.seq)).toEqual([3, 2, 1]);
    expect(events[0]!.context).toEqual({
      storeName: 'Store',
      orderDate: '2026-07-25',
      runDate: null,
      runIndex: null,
      skuNames: { en: 'Rice' },
      qty: '3.500',
    });
  });
});
