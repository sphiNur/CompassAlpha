/**
 * Front-end diagnosis round 5 (2026-11-01), the server side of:
 *   DX-SHL-23 / DX-APR-5 / DX-DLV-13 / DX-CLS  nav.counts — the bottom
 *             nav's badges, per store and per permission;
 *   DX-DLV-13 run.get names the stores whose delivery was recalled;
 *   DX-DLV-02 the "received with problems" notification opens the Run
 *             page for purchasers and the store's receiving page for the
 *             store's managers (who have no Run tab);
 *   DX-APR-7  approval links carry the store;
 *   DX-HIS-6  historyDetail names each line's supplier.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/nav-badges-delivery.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb, schema as s, withOrgContext } from '@compass/db';
import { todayInTz } from '@compass/domain';
import {
  apply as applyOrder,
  decide as decideOrder,
  emptyState as emptyOrderState,
  type OrderState,
} from '@compass/domain/order';
import {
  applyRun,
  decideRun,
  emptyRunState,
  type RunCommand,
  type RunEvent,
  type RunState,
} from '@compass/domain/run';
import { appendEvents } from '../services/eventStore';
import { projectOrder } from '../services/orderProjection';
import { projectRun } from '../services/runProjection';
import { linkForStore } from '../services/notifyForEvent';
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
interface Person {
  caller: Caller;
  userId: string;
  memberId: string;
}
interface Fixture {
  db: ReturnType<typeof getDb>;
  orgId: string;
  storeA: string;
  storeB: string;
  /** Rice, Onion. */
  skuIds: [string, string];
  supplierId: string;
  /** Super admin: every permission, every store. */
  admin: Person;
  /** Built-in manager at store A. */
  manager: Person;
  /** Built-in staff at store A. */
  staff: Person;
  /** Built-in purchaser at store B only. */
  buyerB: Person;
}
let fix: Fixture | null = null;

const ALL_PERMS = new Set([
  'order.draft',
  'order.submit',
  'order.approve',
  'order.claim',
  'run.create',
  'run.purchase',
  'run.finish',
  'delivery.dispatch',
  'delivery.confirm',
]);

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug: `navb-${suffix}`, name: 'Nav badges', localeDefault: 'en', timezone: 'UTC' })
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
  const storeIds: string[] = [];
  for (const name of ['A', 'B']) {
    const [store] = await db
      .insert(s.stores)
      .values({ orgId, name: `Store ${name}`, code: `${name}-${suffix.slice(-6)}` })
      .returning();
    storeIds.push(store!.id);
  }
  const skuIds: string[] = [];
  for (const name of ['Rice', 'Onion']) {
    const [sku] = await db
      .insert(s.skus)
      .values({
        orgId,
        code: `${name}-${suffix.slice(-8)}`,
        names: { en: name },
        unit: 'kg',
        step: '1',
      })
      .returning();
    skuIds.push(sku!.id);
  }
  const [supplier] = await db
    .insert(s.suppliers)
    .values({ orgId, name: 'Bazaar stall 7' })
    .returning();
  let n = 0;
  const person = async (slug: string, stores: string[], scopeStoreId: string | null) => {
    n += 1;
    const [u] = await db
      .insert(s.users)
      .values({ displayName: `Nav ${n}`, tgUserId: BigInt(`${suffix}${n}`.slice(-12)) })
      .returning();
    const [m] = await db
      .insert(s.members)
      .values({ orgId, userId: u!.id, status: 'active' })
      .returning();
    for (const storeId of stores) {
      await db
        .insert(s.memberStoreAssignments)
        .values({ memberId: m!.id, storeId, assignedBy: u!.id });
    }
    await db.insert(s.memberRoleBindings).values({
      memberId: m!.id,
      roleId: roleIds[slug]!,
      scopeType: scopeStoreId ? 'store' : 'global',
      scopeId: scopeStoreId,
    });
    const session = await loadSession(db, u!.id, orgId, m!.id);
    if (!session) throw new Error('session failed to load');
    return { caller: appRouter.createCaller(buildCtx(db, session)), userId: u!.id, memberId: m!.id };
  };
  const [storeA, storeB] = storeIds as [string, string];
  fix = {
    db,
    orgId,
    storeA,
    storeB,
    skuIds: skuIds as [string, string],
    supplierId: supplier!.id,
    admin: await person('super_admin', storeIds, null),
    manager: await person('manager', [storeA], storeA),
    staff: await person('staff', [storeA], storeA),
    buyerB: await person('purchaser', [storeB], storeB),
  };
});

const actorOf = (p: Person) => ({ userId: p.userId, memberId: p.memberId, permissions: ALL_PERMS });

let orderDay = 0;
/** An order of `storeId` for 2 kg of each sku, taken as far as `until`. */
async function seedOrder(
  storeId: string,
  skuIds: readonly string[],
  until: 'submitted' | 'approved' | { runId: string },
): Promise<string> {
  const { orgId, admin } = fix!;
  const db = getDb();
  const sessionId = randomUUID();
  let state: OrderState = emptyOrderState(sessionId);
  const push = async (events: ReturnType<typeof decideOrder>) => {
    for (const e of events) state = applyOrder(state, e);
    await withOrgContext(db, orgId, async (tx) => {
      await appendEvents(tx, {
        streamType: 'order',
        streamId: sessionId,
        orgId,
        events: events.map((e) => ({ ...e })),
      });
      await projectOrder(tx, orgId, events);
    });
  };
  orderDay += 1;
  const orderDate = new Date(Date.UTC(2026, 2, orderDay)).toISOString().slice(0, 10);
  const author = { ...actorOf(admin), isClaimer: false };
  await push(decideOrder(state, { type: 'StartDraft', orgId, storeId, orderDate, actor: author }));
  for (const skuId of skuIds) {
    await push(
      decideOrder(state, {
        type: 'AdjustItem',
        skuId,
        qty: '2',
        sku: { id: skuId, step: '1', unit: 'kg', isArchived: false },
        actor: author,
      }),
    );
  }
  await push(decideOrder(state, { type: 'Submit', actor: author }));
  if (until === 'submitted') return sessionId;
  await push(decideOrder(state, { type: 'Approve', actor: author }));
  if (until === 'approved') return sessionId;
  await push(decideOrder(state, { type: 'AttachToRun', runId: until.runId, actor: author }));
  return sessionId;
}

let runCount = 0;
/**
 * A run with store A's order: rice bought at 1000 from the supplier, onion
 * not found. Delivered to store A.
 */
async function deliveredRun(): Promise<{ runId: string; write: (cmd: RunCommand) => Promise<void> }> {
  const { orgId, storeA, skuIds, admin, supplierId } = fix!;
  const db = getDb();
  const runId = randomUUID();
  const sessionA = await seedOrder(storeA, skuIds, { runId });
  let state: RunState = emptyRunState(runId);
  const writeEvents = async (events: RunEvent[]) => {
    if (events.length === 0) return;
    for (const e of events) state = applyRun(state, e);
    await withOrgContext(db, orgId, async (tx) => {
      await appendEvents(tx, {
        streamType: 'run',
        streamId: runId,
        orgId,
        events: events.map((e) => ({ ...e })),
      });
      await projectRun(tx, orgId, events);
    });
  };
  await writeEvents([
    {
      streamId: runId,
      seq: 1,
      occurredAt: new Date(),
      actorUserId: admin.userId,
      actorMemberId: admin.memberId,
      type: 'RunPlanned',
      payload: {
        orgId,
        runDate: new Date().toISOString().slice(0, 10),
        runIndex: runCount++,
        sessionIds: [sessionA],
        plannedItems: skuIds.map((skuId) => ({ skuId, qty: '2' })),
        purchaserMemberId: admin.memberId,
      },
    } as RunEvent,
  ]);
  const write = async (cmd: RunCommand) => writeEvents(decideRun(state, cmd));
  await write({ type: 'StartPurchase', actor: actorOf(admin) });
  await write({
    type: 'PurchaseItem',
    skuId: skuIds[0],
    supplierId,
    unitPrice: '1000',
    actualQty: '2',
    receiptPhotoUrl: null,
    storeSplits: [{ storeId: storeA, qty: '2' }],
    paymentMethod: 'cash',
    actor: actorOf(admin),
  });
  await write({ type: 'MarkUnavailable', skuId: skuIds[1], note: 'none at the bazaar', actor: actorOf(admin) });
  await write({ type: 'StartDelivery', actor: actorOf(admin) });
  await write({ type: 'DeliverToStore', storeId: storeA, actor: actorOf(admin) });
  return { runId, write };
}

describe.skipIf(!SHOULD_RUN)('nav badges and delivery links (PG-gated)', () => {
  test('nav.counts: 审核 leaves out orders another reviewer holds, per store', async () => {
    const { manager, admin, staff, storeA, storeB, skuIds } = fix!;
    const before = await manager.caller.nav.counts({ storeId: storeA });
    const s1 = await seedOrder(storeA, [skuIds[0]], 'submitted');
    await seedOrder(storeA, [skuIds[1]], 'submitted');
    await seedOrder(storeB, [skuIds[0]], 'submitted');
    const after = await manager.caller.nav.counts({ storeId: storeA });
    expect(after.approve).toBe((before.approve ?? 0) + 2);
    // Store B is not the manager's: no count leaks from it.
    expect((await manager.caller.nav.counts({ storeId: storeB })).approve).toBe(0);

    // The admin takes one: it no longer waits for the manager, but still
    // counts for the admin who holds it.
    await admin.caller.order.claim({ sessionId: s1 });
    expect((await manager.caller.nav.counts({ storeId: storeA })).approve).toBe(after.approve! - 1);
    expect((await admin.caller.nav.counts({ storeId: storeA })).approve).toBe(after.approve);

    // Staff review nothing: no badge at all.
    expect((await staff.caller.nav.counts({ storeId: storeA })).approve).toBeNull();
    await admin.caller.order.releaseClaim({ sessionId: s1 });
  });

  test('nav.counts: 采购 counts approved orders in the stores one may plan for', async () => {
    const { admin, buyerB, manager, storeA, storeB, skuIds } = fix!;
    const adminBefore = (await admin.caller.nav.counts({})).run ?? 0;
    const buyerBefore = (await buyerB.caller.nav.counts({})).run ?? 0;
    await seedOrder(storeA, [skuIds[0]], 'approved');
    await seedOrder(storeB, [skuIds[0]], 'approved');
    expect((await admin.caller.nav.counts({})).run).toBe(adminBefore + 2);
    // A purchaser of store B only sees store B's order.
    expect((await buyerB.caller.nav.counts({ storeId: storeA })).run).toBe(buyerBefore + 1);
    // No run.purchase → no badge.
    expect((await manager.caller.nav.counts({ storeId: storeA })).run).toBeNull();
  });

  test('nav.counts: 验收 follows delivery and recall; run.get names the recalled store', async () => {
    const { staff, manager, buyerB, admin, storeA, storeB } = fix!;
    const before = (await staff.caller.nav.counts({ storeId: storeA })).confirm ?? 0;
    const { runId, write } = await deliveredRun();
    expect((await staff.caller.nav.counts({ storeId: storeA })).confirm).toBe(before + 1);
    expect((await manager.caller.nav.counts({ storeId: storeA })).confirm).toBe(before + 1);
    // Another store, or a person who does not receive goods: nothing.
    expect((await admin.caller.nav.counts({ storeId: storeB })).confirm).toBe(0);
    expect((await buyerB.caller.nav.counts({ storeId: storeB })).confirm).toBeNull();
    expect((await staff.caller.run.get({ runId })).recalledStoreIds).toEqual([]);
    // run.list names the stores each run serves (the onion-only store
    // would otherwise look like "nothing coming").
    const listed = (await admin.caller.run.list()).find((r) => r.id === runId);
    expect(listed?.storeIds).toEqual([storeA]);

    await write({ type: 'UndeliverStore', storeId: storeA, reason: 'wrong van', actor: actorOf(admin) });
    expect((await staff.caller.nav.counts({ storeId: storeA })).confirm).toBe(before);
    const recalled = await staff.caller.run.get({ runId });
    expect(recalled.recalledStoreIds).toEqual([storeA]);
    // The onion the purchaser did not find is on the run for store A, with
    // the reason, so the receiving page can list it as 没买到.
    const onion = recalled.items.find((it) => it.skuId === fix!.skuIds[1]);
    expect(onion?.status).toBe('unavailable');
    expect(onion?.unavailableNote).toBe('none at the bazaar');
    expect(
      recalled.perStoreDemand.some((d) => d.storeId === storeA && d.skuId === fix!.skuIds[1]),
    ).toBe(true);

    await write({ type: 'DeliverToStore', storeId: storeA, actor: actorOf(admin) });
    expect((await staff.caller.run.get({ runId })).recalledStoreIds).toEqual([]);
    expect((await staff.caller.nav.counts({ storeId: storeA })).confirm).toBe(before + 1);
    await staff.caller.run.markStoreItemsOk({ runId, storeId: storeA, skuIds: [fix!.skuIds[0]] });
    await staff.caller.run.confirmStore({ runId, storeId: storeA });
    expect((await staff.caller.nav.counts({ storeId: storeA })).confirm).toBe(before);
  });

  test("nav.counts: 日结 is due until today's close is filed", async () => {
    const { db, orgId, manager, staff, storeA } = fix!;
    expect((await manager.caller.nav.counts({ storeId: storeA })).settlementDue).toBe(true);
    // Staff do not close the day.
    expect((await staff.caller.nav.counts({ storeId: storeA })).settlementDue).toBeNull();
    // Without a store chosen there is no store to close.
    expect((await manager.caller.nav.counts({})).settlementDue).toBeNull();
    await db.insert(s.storeDailySettlements).values({
      orgId,
      storeId: storeA,
      settlementDate: todayInTz('UTC'),
    });
    expect((await manager.caller.nav.counts({ storeId: storeA })).settlementDue).toBe(false);
  });

  test('DX-DLV-02: the problems notification opens the receiving page for the manager', async () => {
    const { db, orgId, staff, manager, admin, storeA, skuIds } = fix!;
    const { runId } = await deliveredRun();
    await staff.caller.run.confirmStoreItem({
      runId,
      storeId: storeA,
      skuId: skuIds[0],
      status: 'short',
      receivedQty: '1',
      note: 'one bag missing',
      photoUrl: null,
    });
    await staff.caller.run.confirmStore({ runId, storeId: storeA });
    const rows = await db
      .select({ to: s.notifications.recipientUserId, link: s.notifications.deepLink })
      .from(s.notifications)
      .where(
        and(
          eq(s.notifications.orgId, orgId),
          eq(s.notifications.template, 'run.storeConfirmedWithIssues'),
        ),
      );
    const linkFor = (userId: string) => [...new Set(rows.filter((r) => r.to === userId).map((r) => r.link))];
    expect(linkFor(manager.userId)).toEqual([linkForStore('/confirm', storeA)]);
    // The admin bought the run (and may buy anywhere): the Run page.
    expect(linkFor(admin.userId)).toEqual(['/run']);
  });

  test('DX-APR-7: the new-order link names the store', async () => {
    const { db, orgId, staff, manager, storeA, skuIds } = fix!;
    const { sessionId } = await staff.caller.order.adjustItem({
      storeId: storeA,
      skuId: skuIds[0],
      qty: '1',
    });
    await staff.caller.order.submit({ sessionId });
    const [row] = await db
      .select({ link: s.notifications.deepLink })
      .from(s.notifications)
      .where(
        and(
          eq(s.notifications.orgId, orgId),
          eq(s.notifications.template, 'order.submitted'),
          eq(s.notifications.recipientUserId, manager.userId),
        ),
      )
      .limit(1);
    expect(row?.link).toBe(`/approve?store=${storeA}`);
  });

  test('DX-HIS-6: historyDetail names the supplier of each line', async () => {
    const { admin, staff, storeA, skuIds, supplierId } = fix!;
    const { runId } = await deliveredRun();
    await staff.caller.run.markStoreItemsOk({ runId, storeId: storeA, skuIds: [skuIds[0]] });
    await staff.caller.run.confirmStore({ runId, storeId: storeA });
    await admin.caller.run.finish({ runId });
    const detail = await admin.caller.run.historyDetail({ runId });
    expect(detail.supplierNameById).toEqual({ [supplierId]: 'Bazaar stall 7' });
  });
});
