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
    expect(err?.message).toBe('admin.errors.runHasForeignSessions');
    expect(await db.query.marketRunsV.findFirst({ where: (x, o) => o.eq(x.id, runId) })).toBeTruthy();
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
    const [org] = await db.select({ slug: s.organizations.slug }).from(s.organizations).where(eq(s.organizations.id, orgId));
    // Runs before the CAT-2 test adds a daily close (which blocks this).
    await admin.admin.purgeAllTestData({ dryRun: false, confirmText: org!.slug });
    const after = await db.query.policyDecisions.findMany({ where: (x, o) => o.eq(x.orgId, orgId) });
    expect(after.length).toBe(before.length + 1);
    expect(after.some((r) => r.action === 'admin.purge.all')).toBe(true);
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
});
