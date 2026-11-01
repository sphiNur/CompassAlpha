/**
 * Purchase and delivery, second re-audit (2026-10-31):
 *   R2-BUY-1  run.get's extras carry the session's seq, so the purchase
 *             page can send markExtraStatus's expectedSeq;
 *   R2-APR-3  an expectedSeq the order never reached (ahead, negative) is
 *             refused;
 *   RE-DLV-3  run.get says whether the caller may finish, and why not;
 *   D9        a purchaser of some stores records expenses split to their
 *             stores only;
 *   R2-DLV-1  undoing and re-buying a line in a correction keeps the
 *             store's verdict, and stock follows what it received;
 *   D3 / D4   quantity added in a correction and a price changed after
 *             receipt are labelled for history; neither touches stock
 *             beyond what the store received.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/purchase-delivery-r2.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb, schema as s, withOrgContext } from '@compass/db';
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
  /** Store A: the scoped purchaser's store. Store B: someone else's. */
  storeA: string;
  storeB: string;
  /** Rice (store A's order), Onion (store B's order), Salt (not ordered). */
  skuIds: [string, string, string];
  /** Super admin: every permission. */
  admin: Person;
  /** Built-in purchaser bound to store A only. */
  buyerA: Person;
  /** Super admin denied run.finish at store B. */
  deniedB: Person;
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

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug: `pdr2-${suffix}`, name: 'Purchase r2', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  const orgId = org!.id;
  const roleIds: Record<string, string> = {};
  for (const slug of ['super_admin', 'purchaser']) {
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
  for (const name of ['Rice', 'Onion', 'Salt']) {
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
  let n = 0;
  const person = async (
    slug: 'super_admin' | 'purchaser',
    stores: string[],
    scopeStoreId: string | null,
  ): Promise<Person> => {
    n += 1;
    const [u] = await db
      .insert(s.users)
      .values({ displayName: `R2 ${n}`, tgUserId: BigInt(`${suffix}${n}`.slice(-12)) })
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
    return { caller: null as unknown as Caller, userId: u!.id, memberId: m!.id };
  };
  const withCaller = async (p: Person): Promise<Person> => {
    const session = await loadSession(db, p.userId, orgId, p.memberId);
    if (!session) throw new Error('session failed to load');
    return { ...p, caller: appRouter.createCaller(buildCtx(db, session)) };
  };
  const admin = await withCaller(await person('super_admin', storeIds, null));
  const buyerA = await withCaller(await person('purchaser', [storeIds[0]!], storeIds[0]!));
  const deniedRaw = await person('super_admin', storeIds, null);
  await db.insert(s.memberPermissionOverrides).values({
    memberId: deniedRaw.memberId,
    permissionKey: 'run.finish',
    effect: 'deny',
    scopeType: 'store',
    scopeId: storeIds[1]!,
  });
  const deniedB = await withCaller(deniedRaw);
  fix = {
    db,
    orgId,
    storeA: storeIds[0]!,
    storeB: storeIds[1]!,
    skuIds: skuIds as [string, string, string],
    admin,
    buyerA,
    deniedB,
  };
});

// ---------- fixtures written as domain events

const actorOf = (p: Person) => ({ userId: p.userId, memberId: p.memberId, permissions: ALL_PERMS });
const orderActorOf = (p: Person) => ({ ...actorOf(p), isClaimer: false });

let orderDay = 0;
/** An order of `storeId` for 2 kg of `skuId` (+ extras), carried into `runId`. */
async function seedOrder(storeId: string, skuId: string, runId: string, extras = 0) {
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
  const orderDate = new Date(Date.UTC(2026, 1, orderDay)).toISOString().slice(0, 10);
  const author = orderActorOf(admin);
  await push(decideOrder(state, { type: 'StartDraft', orgId, storeId, orderDate, actor: author }));
  await push(
    decideOrder(state, {
      type: 'AdjustItem',
      skuId,
      qty: '2',
      sku: { id: skuId, step: '1', unit: 'kg', isArchived: false },
      actor: author,
    }),
  );
  if (extras > 0) {
    await push(
      decideOrder(state, {
        type: 'SetSessionExtras',
        extras: Array.from({ length: extras }, (_, i) => ({
          name: `extra ${i}`,
          qty: '1',
          unit: 'kg',
        })),
        actor: author,
      }),
    );
  }
  await push(decideOrder(state, { type: 'Submit', actor: author }));
  await push(decideOrder(state, { type: 'Approve', actor: author }));
  await push(decideOrder(state, { type: 'AttachToRun', runId, actor: author }));
  return sessionId;
}

let runCount = 0;
/**
 * A run with store A's order (2 kg rice, two extras) and store B's order
 * (2 kg onion), bought as ordered at 1000. `stage` says how far it goes.
 */
async function seedRun(stage: 'purchasing' | 'delivered'): Promise<{
  runId: string;
  sessionA: string;
}> {
  const { orgId, storeA, storeB, skuIds, admin } = fix!;
  const db = getDb();
  const runId = randomUUID();
  const sessionA = await seedOrder(storeA, skuIds[0], runId, 2);
  const sessionB = await seedOrder(storeB, skuIds[1], runId);
  let state: RunState = emptyRunState(runId);
  const write = async (events: RunEvent[]) => {
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
  await write([
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
        sessionIds: [sessionA, sessionB],
        plannedItems: [
          { skuId: skuIds[0], qty: '2' },
          { skuId: skuIds[1], qty: '2' },
        ],
        purchaserMemberId: admin.memberId,
      },
    } as RunEvent,
  ]);
  const cmds: RunCommand[] = [{ type: 'StartPurchase', actor: actorOf(admin) }];
  if (stage === 'delivered') {
    cmds.push(
      ...([
        [skuIds[0], storeA],
        [skuIds[1], storeB],
      ] as const).map(
        ([skuId, storeId]): RunCommand => ({
          type: 'PurchaseItem',
          skuId,
          supplierId: null,
          unitPrice: '1000',
          actualQty: '2',
          receiptPhotoUrl: null,
          storeSplits: [{ storeId, qty: '2' }],
          paymentMethod: 'cash',
          actor: actorOf(admin),
        }),
      ),
      { type: 'StartDelivery', actor: actorOf(admin) },
      { type: 'DeliverToStore', storeId: storeA, actor: actorOf(admin) },
      { type: 'DeliverToStore', storeId: storeB, actor: actorOf(admin) },
    );
  }
  for (const cmd of cmds) await write(decideRun(state, cmd));
  return { runId, sessionA };
}

/** One run may be planned or purchasing per org: cancel it when done. */
async function retire(runId: string): Promise<void> {
  await fix!.admin.caller.run.cancel({ runId, reason: 'test done' });
}

async function stockOf(storeId: string, skuId: string, runId: string): Promise<number> {
  const rows = await fix!.db
    .select({ delta: s.inventoryMovements.delta })
    .from(s.inventoryMovements)
    .where(
      and(
        eq(s.inventoryMovements.storeId, storeId),
        eq(s.inventoryMovements.skuId, skuId),
        eq(s.inventoryMovements.sourceId, runId),
      ),
    );
  return rows.reduce((sum, row) => sum + Number(row.delta), 0);
}

async function sessionSeq(sessionId: string): Promise<number> {
  const [row] = await fix!.db
    .select({ lastSeq: s.orderSessionsV.lastSeq })
    .from(s.orderSessionsV)
    .where(eq(s.orderSessionsV.id, sessionId));
  return row!.lastSeq;
}

describe.skipIf(!SHOULD_RUN)('purchase page (PG-gated)', () => {
  test("R2-BUY-1: run.get's extras carry the session's seq", async () => {
    const { admin, storeA } = fix!;
    const { runId, sessionA } = await seedRun('purchasing');
    const run = await admin.caller.run.get({ runId });
    const extras = run.sessionExtrasByStore[storeA] ?? [];
    expect(extras.length).toBe(2);
    const seq = await sessionSeq(sessionA);
    expect(seq).toBeGreaterThan(0);
    for (const extra of extras) expect(extra.sessionSeq).toBe(seq);
    await retire(runId);
  });

  test('R2-APR-3: an expectedSeq ahead of the order or negative is refused', async () => {
    const { admin } = fix!;
    const { runId, sessionA } = await seedRun('purchasing');
    const seen = await sessionSeq(sessionA);
    for (const expectedSeq of [seen + 50, -1]) {
      const err = await errorOf(() =>
        admin.caller.order.markExtraStatus({
          sessionId: sessionA,
          extraIndex: 0,
          status: 'bought',
          expectedSeq,
        }),
      );
      expect(err?.code).toBe('CONFLICT');
      expect(err?.message).toBe('order.errors.staleSeq');
    }
    // The seq the page read still works.
    await admin.caller.order.markExtraStatus({
      sessionId: sessionA,
      extraIndex: 0,
      status: 'bought',
      expectedSeq: seen,
    });
    await retire(runId);
  });

  test('DX-BUY-2: a top-up saved as its own batch keeps the earlier price', async () => {
    const { admin, storeA, storeB, skuIds } = fix!;
    const { runId } = await seedRun('purchasing');
    try {
      await admin.caller.run.purchaseItem({
        runId,
        skuId: skuIds[0],
        supplierId: null,
        unitPrice: '80000',
        actualQty: '2',
        receiptPhotoUrl: null,
        storeSplits: [{ storeId: storeA, qty: '2' }],
        paymentMethod: 'cash',
      });
      // What the web's topUpRevision sends: the row keeps 80,000; the
      // store that only gets the extra is priced at this batch's 82,000.
      await admin.caller.run.revisePurchase({
        runId,
        skuId: skuIds[0],
        supplierId: null,
        unitPrice: '80000',
        actualQty: '4',
        receiptPhotoUrl: null,
        storeSplits: [
          { storeId: storeA, qty: '2' },
          { storeId: storeB, qty: '2', unitPrice: '82000', paymentMethod: 'transfer' },
        ],
        paymentMethod: 'cash',
        reason: 'top-up',
      });
      const run = await admin.caller.run.get({ runId });
      const item = run.items.find((it) => it.skuId === skuIds[0])!;
      expect(Number(item.unitPrice)).toBe(80000);
      expect(Number(item.purchasedQty)).toBe(4);
      // 2 × 80,000 + 2 × 82,000 = 324,000 paid, not 4 × 82,000.
      const riceSplits = run.splits.filter((sp) => sp.skuId === skuIds[0]);
      expect(
        riceSplits.reduce(
          (sum, sp) => sum + Number(sp.qty) * Number(sp.unitPrice ?? item.unitPrice),
          0,
        ),
      ).toBe(324000);
    } finally {
      await retire(runId);
    }
  });

  test('D9: a purchaser of store A records and removes expenses split to store A only', async () => {
    const { admin, buyerA, storeA, storeB } = fix!;
    const { runId } = await seedRun('purchasing');
    const expense = (storeSplits: Array<{ storeId: string; qty: string }>) => ({
      runId,
      expenseId: randomUUID(),
      label: 'Taxi',
      qty: storeSplits.reduce((sum, sp) => sum + Number(sp.qty), 0).toString(),
      unitPrice: '20000',
      storeSplits,
      paymentMethod: 'cash' as const,
      receiptPhotoUrl: null,
      reason: 'to the market',
    });
    const own = expense([{ storeId: storeA, qty: '1' }]);
    const added = await buyerA.caller.run.addExpense(own);
    expect(added.eventCount).toBe(1);

    const shared = expense([
      { storeId: storeA, qty: '1' },
      { storeId: storeB, qty: '1' },
    ]);
    const refused = await errorOf(() => buyerA.caller.run.addExpense(shared));
    expect(refused?.code).toBe('FORBIDDEN');
    expect(refused?.message).toBe('run.errors.expenseServesOtherStores');

    // An expense someone else split to both stores is not theirs to remove.
    await admin.caller.run.addExpense(shared);
    const removeShared = await errorOf(() =>
      buyerA.caller.run.removeExpense({ runId, expenseId: shared.expenseId, reason: 'x' }),
    );
    expect(removeShared?.message).toBe('run.errors.expenseServesOtherStores');
    const removed = await buyerA.caller.run.removeExpense({
      runId,
      expenseId: own.expenseId,
      reason: 'wrong',
    });
    expect(removed.eventCount).toBe(1);
    // Run-wide steps still need every store.
    const start = await errorOf(() => buyerA.caller.run.startDelivery({ runId }));
    expect(start?.message).toBe('run.errors.runHasOtherStores');
    await retire(runId);
  });

  test("F2 (security scan): another run's expense id is refused and never removed", async () => {
    const { db, orgId, admin, buyerA, storeA, storeB } = fix!;
    // R1, already delivered, has a store-B expense E1.
    const { runId: r1 } = await seedRun('delivered');
    const e1 = randomUUID();
    await withOrgContext(db, orgId, (tx) =>
      tx.insert(s.runExpensesV).values({
        id: e1,
        runId: r1,
        orgId,
        label: 'Truck',
        qty: '1',
        unitPrice: '500000',
        storeSplitsJson: [{ storeId: storeB, qty: '1' }],
        paymentMethod: 'cash',
        reason: 'delivery',
        addedByMemberId: admin.memberId,
        addedAt: new Date(),
      }),
    );
    const e1Row = () =>
      withOrgContext(db, orgId, async (tx) => {
        const [row] = await tx
          .select({ runId: s.runExpensesV.runId, removedAt: s.runExpensesV.removedAt })
          .from(s.runExpensesV)
          .where(eq(s.runExpensesV.id, e1));
        return row;
      });

    // On the live run R2, a store-A purchaser reuses E1's id.
    const { runId: r2 } = await seedRun('purchasing');
    const err = await errorOf(() =>
      buyerA.caller.run.addExpense({
        runId: r2,
        expenseId: e1,
        label: 'Taxi',
        qty: '1',
        unitPrice: '1000',
        storeSplits: [{ storeId: storeA, qty: '1' }],
        paymentMethod: 'cash',
        receiptPhotoUrl: null,
        reason: 'x',
      }),
    );
    expect(err?.code).toBe('BAD_REQUEST');
    expect(err?.message).toBe('run.errors.expenseIdTaken');
    // Nothing was recorded on R2, so there is nothing for it to remove.
    const r2Events = await withOrgContext(db, orgId, (tx) =>
      tx
        .select({ type: s.events.type })
        .from(s.events)
        .where(eq(s.events.streamId, r2)),
    );
    expect(r2Events.some((e) => e.type === 'RunExpenseAdded')).toBe(false);
    const removeErr = await errorOf(() =>
      buyerA.caller.run.removeExpense({ runId: r2, expenseId: e1, reason: 'gone' }),
    );
    expect(removeErr).not.toBeNull();
    expect(await e1Row()).toEqual({ runId: r1, removedAt: null });

    // And the removal projection itself only touches its own run's row
    // (checked in a transaction that is then rolled back).
    const rolledBack = new Error('rollback');
    await withOrgContext(db, orgId, async (tx) => {
      await projectRun(tx, orgId, [
        {
          streamId: r2,
          seq: 999,
          occurredAt: new Date(),
          actorUserId: buyerA.userId,
          actorMemberId: buyerA.memberId,
          type: 'RunExpenseRemoved',
          payload: { expenseId: e1, reason: 'forged', byMemberId: buyerA.memberId },
        } as RunEvent,
      ]);
      const [row] = await tx
        .select({ removedAt: s.runExpensesV.removedAt })
        .from(s.runExpensesV)
        .where(eq(s.runExpensesV.id, e1));
      expect(row?.removedAt).toBeNull();
      throw rolledBack;
    }).catch((e) => {
      if (e !== rolledBack) throw e;
    });
    await retire(r2);
  });
});

describe.skipIf(!SHOULD_RUN)('delivery and corrections (PG-gated)', () => {
  test('RE-DLV-3: run.get says who may finish', async () => {
    const { admin, buyerA, deniedB } = fix!;
    const { runId } = await seedRun('delivered');
    expect((await admin.caller.run.get({ runId })).finishBlockedReason).toBeNull();
    expect((await deniedB.caller.run.get({ runId })).finishBlockedReason).toBe(
      'run.errors.runHasOtherStores',
    );
    expect((await buyerA.caller.run.get({ runId })).finishBlockedReason).toBe(
      'run.errors.runHasOtherStores',
    );
    // Same answer as the mutation itself.
    const err = await errorOf(() => deniedB.caller.run.finish({ runId }));
    expect(err?.message).toBe('run.errors.runHasOtherStores');
  });

  test('R2-DLV-1 + D3: re-buying in a correction keeps the verdict; added quantity is labelled', async () => {
    const { admin, storeA, storeB, skuIds, db } = fix!;
    const { runId } = await seedRun('delivered');
    // Store A received only 1 of its 2 kg of rice.
    await admin.caller.run.confirmStoreItem({
      runId,
      storeId: storeA,
      skuId: skuIds[0],
      status: 'short',
      note: 'half a bag',
      photoUrl: null,
      receivedQty: '1',
    });
    await admin.caller.run.confirmStore({ runId, storeId: storeA });
    await admin.caller.run.markStoreItemsOk({ runId, storeId: storeB, skuIds: [skuIds[1]] });
    await admin.caller.run.confirmStore({ runId, storeId: storeB });
    await admin.caller.run.finish({ runId });
    expect(await stockOf(storeA, skuIds[0], runId)).toBe(1);

    await admin.caller.run.reopen({ runId, reason: 'fix the rice record' });
    await admin.caller.run.undoPurchase({ runId, skuId: skuIds[0], reason: 'typo' });
    await admin.caller.run.purchaseItem({
      runId,
      skuId: skuIds[0],
      supplierId: null,
      unitPrice: '1100',
      actualQty: '2',
      receiptPhotoUrl: null,
      storeSplits: [{ storeId: storeA, qty: '2' }],
      paymentMethod: 'cash',
    });
    // D3: a product new to store A, added in the correction.
    await admin.caller.run.addPurchaserItem({
      runId,
      skuId: skuIds[2],
      supplierId: null,
      unitPrice: '500',
      actualQty: '3',
      receiptPhotoUrl: null,
      storeSplits: [{ storeId: storeA, qty: '3' }],
      paymentMethod: 'cash',
      reason: 'forgot the salt',
    });
    await admin.caller.run.refinalize({ runId });

    const [rice] = await db
      .select()
      .from(s.runItemStoresV)
      .where(
        and(
          eq(s.runItemStoresV.runId, runId),
          eq(s.runItemStoresV.skuId, skuIds[0]),
          eq(s.runItemStoresV.storeId, storeA),
        ),
      );
    expect(rice!.confirmStatus).toBe('short');
    expect(Number(rice!.confirmReceivedQty)).toBe(1);
    expect(rice!.confirmNote).toBe('half a bag');
    expect(rice!.deliveredAt).toBeTruthy();
    expect(rice!.confirmedAt).toBeTruthy();
    // Stock follows what the store received, not the allocation.
    expect(await stockOf(storeA, skuIds[0], runId)).toBe(1);
    // The added salt counts as received.
    expect(await stockOf(storeA, skuIds[2], runId)).toBe(3);

    const detail = await admin.caller.run.historyDetail({ runId });
    expect(detail.corrections).toEqual([
      { kind: 'amendAdded', skuId: skuIds[2], storeId: storeA, qty: '3' },
    ]);
  });

  test('DX-DLV-01: quantity a correction adds to a short line reaches stock', async () => {
    const { admin, storeA, storeB, skuIds } = fix!;
    const { runId } = await seedRun('delivered');
    // Store A received only 1 of its 2 kg of rice.
    await admin.caller.run.confirmStoreItem({
      runId,
      storeId: storeA,
      skuId: skuIds[0],
      status: 'short',
      note: 'one bag short',
      photoUrl: null,
      receivedQty: '1',
    });
    await admin.caller.run.confirmStore({ runId, storeId: storeA });
    await admin.caller.run.markStoreItemsOk({ runId, storeId: storeB, skuIds: [skuIds[1]] });
    await admin.caller.run.confirmStore({ runId, storeId: storeB });
    await admin.caller.run.finish({ runId });
    expect(await stockOf(storeA, skuIds[0], runId)).toBe(1);

    // The correction gives store A 2 kg more (2 → 4).
    await admin.caller.run.reopen({ runId, reason: 'two more bags went out' });
    await admin.caller.run.revisePurchase({
      runId,
      skuId: skuIds[0],
      supplierId: null,
      unitPrice: '1000',
      actualQty: '4',
      receiptPhotoUrl: null,
      storeSplits: [{ storeId: storeA, qty: '4' }],
      paymentMethod: 'cash',
      reason: 'two more bags',
    });
    await admin.caller.run.refinalize({ runId });

    // D3: received 1 + added 2 — the shortfall stays recorded, the added
    // quantity is stock (it used to stay at 1).
    expect(await stockOf(storeA, skuIds[0], runId)).toBe(3);
    const detail = await admin.caller.run.historyDetail({ runId });
    expect(detail.corrections).toContainEqual({
      kind: 'amendAdded',
      skuId: skuIds[0],
      storeId: storeA,
      qty: '2',
    });
    const split = detail.splits.find((sp) => sp.skuId === skuIds[0] && sp.storeId === storeA);
    expect(split).toMatchObject({ confirmStatus: 'short' });
    expect(Number(split!.confirmReceivedQty)).toBe(1);

    // A second close rewrites the same rows (no double booking).
    await admin.caller.run.reopen({ runId, reason: 'look again' });
    await admin.caller.run.refinalize({ runId });
    expect(await stockOf(storeA, skuIds[0], runId)).toBe(3);
  });

  test('D4: a price changed after receipt changes the amount, not stock, and is kept', async () => {
    const { admin, storeA, storeB, skuIds } = fix!;
    const { runId } = await seedRun('delivered');
    await admin.caller.run.markStoreItemsOk({ runId, storeId: storeA, skuIds: [skuIds[0]] });
    await admin.caller.run.confirmStore({ runId, storeId: storeA });
    await admin.caller.run.revisePurchase({
      runId,
      skuId: skuIds[0],
      supplierId: null,
      unitPrice: '1500',
      actualQty: '2',
      receiptPhotoUrl: null,
      storeSplits: [{ storeId: storeA, qty: '2' }],
      paymentMethod: 'transfer',
      reason: 'receipt came later',
    });
    // Quantity still stands once the store has the goods.
    const qty = await errorOf(() =>
      admin.caller.run.revisePurchase({
        runId,
        skuId: skuIds[0],
        supplierId: null,
        unitPrice: '1500',
        actualQty: '3',
        receiptPhotoUrl: null,
        storeSplits: [{ storeId: storeA, qty: '3' }],
        paymentMethod: 'transfer',
        reason: 'more',
      }),
    );
    expect(qty?.message).toBe('run.errors.cannotReviseAfterDelivery');
    await admin.caller.run.markStoreItemsOk({ runId, storeId: storeB, skuIds: [skuIds[1]] });
    await admin.caller.run.confirmStore({ runId, storeId: storeB });
    await admin.caller.run.finish({ runId });
    expect(await stockOf(storeA, skuIds[0], runId)).toBe(2);
    const detail = await admin.caller.run.historyDetail({ runId });
    expect(detail.corrections).toMatchObject([
      {
        kind: 'priceAfterReceipt',
        skuId: skuIds[0],
        storeId: null,
        from: '1000',
        to: '1500',
        reason: 'receipt came later',
      },
    ]);
  });
});
