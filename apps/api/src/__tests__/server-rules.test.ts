/**
 * Server rules that were looser than the screens (2026-10-30 review):
 *   DLV-19   run.confirmStore wrote "ok" for every line nobody checked;
 *   DLV-12   "short" was accepted with the whole split received;
 *   DLV-15   closing a correction overwrote when the run finished;
 *   APR-18   markExtraStatus's expectedSeq: someone else's change is
 *            refused, the caller's own taps in a row are not;
 *   RE-APR-2 two approvers taking over one claim both "succeeded", the
 *            release did not say whose claim it ended, and taking over
 *            one's own claim wrote two events.
 *
 * Fixtures are written as domain events (the way the other route tests
 * seed state); the behaviour under test goes through the router.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/server-rules.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
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
  storeId: string;
  skuIds: [string, string];
  /** Super admins: every permission, so only the rule under test decides. */
  a: Person;
  b: Person;
  c: Person;
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
    .values({ slug: `rules-${suffix}`, name: 'Server rules', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  const orgId = org!.id;
  const def = BUILTIN_ROLES.find((r) => r.slug === 'super_admin')!;
  const [role] = await db
    .insert(s.roles)
    .values({ orgId, slug: 'super_admin', name: 'super_admin', rank: def.rank, isBuiltIn: true })
    .returning();
  for (const key of def.permissions) {
    await db.insert(s.permissions).values({ key, description: key }).onConflictDoNothing();
    await db
      .insert(s.rolePermissions)
      .values({ roleId: role!.id, permissionKey: key })
      .onConflictDoNothing();
  }
  const [store] = await db
    .insert(s.stores)
    .values({ orgId, name: 'Store', code: `R-${suffix.slice(-6)}` })
    .returning();
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
  let n = 0;
  const person = async (): Promise<Person> => {
    n += 1;
    const [u] = await db
      .insert(s.users)
      .values({ displayName: `Rules ${n}`, tgUserId: BigInt(`${suffix}${n}`.slice(-12)) })
      .returning();
    const [m] = await db
      .insert(s.members)
      .values({ orgId, userId: u!.id, status: 'active' })
      .returning();
    await db
      .insert(s.memberStoreAssignments)
      .values({ memberId: m!.id, storeId: store!.id, assignedBy: u!.id });
    await db
      .insert(s.memberRoleBindings)
      .values({ memberId: m!.id, roleId: role!.id, scopeType: 'global' });
    const session = await loadSession(db, u!.id, orgId, m!.id);
    if (!session) throw new Error('session failed to load');
    return {
      caller: appRouter.createCaller(buildCtx(db, session)),
      userId: u!.id,
      memberId: m!.id,
    };
  };
  fix = {
    db,
    orgId,
    storeId: store!.id,
    skuIds: skuIds as [string, string],
    a: await person(),
    b: await person(),
    c: await person(),
  };
});

// ---------- run fixtures

const actorOf = (p: Person) => ({ userId: p.userId, memberId: p.memberId, permissions: ALL_PERMS });
const orderActorOf = (p: Person) => ({ ...actorOf(p), isClaimer: false });

let runCount = 0;
/** A run delivered to the store, both products split to it (2 kg each). */
async function deliveredRun(): Promise<string> {
  const { orgId, storeId, skuIds, a } = fix!;
  // The application handle, as run-change-date does: the projection's
  // inserts are checked by the tenant policies.
  const db = getDb();
  const runId = randomUUID();
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
      actorUserId: a.userId,
      actorMemberId: a.memberId,
      type: 'RunPlanned',
      payload: {
        orgId,
        runDate: new Date().toISOString().slice(0, 10),
        // One run per (day, index).
        runIndex: runCount++,
        sessionIds: [],
        plannedItems: skuIds.map((skuId) => ({ skuId, qty: '2' })),
        purchaserMemberId: a.memberId,
      },
    } as RunEvent,
  ]);
  const cmds: RunCommand[] = [
    { type: 'StartPurchase', actor: actorOf(a) },
    ...skuIds.map(
      (skuId): RunCommand => ({
        type: 'PurchaseItem',
        skuId,
        supplierId: null,
        unitPrice: '1000',
        actualQty: '2',
        receiptPhotoUrl: null,
        storeSplits: [{ storeId, qty: '2' }],
        paymentMethod: 'cash',
        actor: actorOf(a),
      }),
    ),
    { type: 'StartDelivery', actor: actorOf(a) },
    { type: 'DeliverToStore', storeId, actor: actorOf(a) },
  ];
  for (const cmd of cmds) await write(decideRun(state, cmd));
  return runId;
}

describe.skipIf(!SHOULD_RUN)('delivery rules (PG-gated)', () => {
  test('DLV-19: the store cannot be confirmed with a line nobody checked', async () => {
    const { a, storeId, skuIds, db } = fix!;
    const runId = await deliveredRun();
    await a.caller.run.confirmStoreItem({
      runId,
      storeId,
      skuId: skuIds[0],
      status: 'ok',
      note: null,
      photoUrl: null,
    });
    const err = await errorOf(() => a.caller.run.confirmStore({ runId, storeId }));
    expect(err?.code).toBe('PRECONDITION_FAILED');
    expect(err?.message).toBe('run.errors.storeItemsUnchecked');
    // Nothing was written for the unchecked line.
    const confirms = await db
      .select({ id: s.events.id })
      .from(s.events)
      .where(and(eq(s.events.streamId, runId), eq(s.events.type, 'StoreItemConfirmed')));
    expect(confirms.length).toBe(1);

    // "All OK" is its own explicit step; then the store confirms.
    await a.caller.run.markStoreItemsOk({ runId, storeId, skuIds: [skuIds[1]] });
    const ok = await a.caller.run.confirmStore({ runId, storeId });
    expect(ok.eventCount).toBe(1);
  });

  test('DLV-12: "short" with the whole split received is refused', async () => {
    const { a, storeId, skuIds } = fix!;
    const runId = await deliveredRun();
    const full = await errorOf(() =>
      a.caller.run.confirmStoreItem({
        runId,
        storeId,
        skuId: skuIds[0],
        status: 'short',
        note: 'late',
        photoUrl: null,
        receivedQty: '2',
      }),
    );
    expect(full?.code).toBe('BAD_REQUEST');
    expect(full?.message).toBe('run.errors.receivedQtyNotShort');
    const partial = await a.caller.run.confirmStoreItem({
      runId,
      storeId,
      skuId: skuIds[0],
      status: 'short',
      note: 'late',
      photoUrl: null,
      receivedQty: '1.5',
    });
    expect(partial.eventCount).toBe(1);
  });

  test('DLV-15: closing a correction keeps the time the run finished', async () => {
    const { a, storeId, skuIds, db } = fix!;
    const runId = await deliveredRun();
    await a.caller.run.markStoreItemsOk({ runId, storeId, skuIds });
    await a.caller.run.confirmStore({ runId, storeId });
    await a.caller.run.finish({ runId });
    const finishedAt = async () =>
      (
        await db
          .select({ at: s.marketRunsV.finishedAt })
          .from(s.marketRunsV)
          .where(eq(s.marketRunsV.id, runId))
      )[0]!.at;
    const original = await finishedAt();
    expect(original).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    await a.caller.run.reopen({ runId, reason: 'check the figures' });
    await a.caller.run.refinalize({ runId });
    expect((await finishedAt())!.getTime()).toBe(original!.getTime());
  });
});

// ---------- order fixtures

let orderDay = 0;
/** A submitted order of person `by`, optionally claimed and carried into a run. */
async function seedOrder(opts: {
  claimedBy?: Person;
  extras?: number;
  inRun?: boolean;
}): Promise<string> {
  const { orgId, storeId, skuIds, c } = fix!;
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
  // A distinct past day per order: one draft per person, store and day.
  orderDay += 1;
  const orderDate = new Date(Date.UTC(2026, 0, orderDay)).toISOString().slice(0, 10);
  const author = orderActorOf(c);
  await push(decideOrder(state, { type: 'StartDraft', orgId, storeId, orderDate, actor: author }));
  await push(
    decideOrder(state, {
      type: 'AdjustItem',
      skuId: skuIds[0],
      qty: '1',
      sku: { id: skuIds[0], step: '1', unit: 'kg', isArchived: false },
      actor: author,
    }),
  );
  if (opts.extras) {
    await push(
      decideOrder(state, {
        type: 'SetSessionExtras',
        extras: Array.from({ length: opts.extras }, (_, i) => ({
          name: `extra ${i}`,
          qty: '1',
          unit: 'kg',
        })),
        actor: author,
      }),
    );
  }
  await push(decideOrder(state, { type: 'Submit', actor: author }));
  if (opts.claimedBy) {
    await push(decideOrder(state, { type: 'Claim', actor: orderActorOf(opts.claimedBy) }));
  }
  if (opts.inRun) {
    await push(decideOrder(state, { type: 'Approve', actor: author }));
    await push(decideOrder(state, { type: 'AttachToRun', runId: randomUUID(), actor: author }));
  }
  return sessionId;
}

async function lastSeqOf(sessionId: string): Promise<number> {
  const [row] = await fix!.db
    .select({ lastSeq: s.orderSessionsV.lastSeq })
    .from(s.orderSessionsV)
    .where(eq(s.orderSessionsV.id, sessionId));
  return row!.lastSeq;
}

describe.skipIf(!SHOULD_RUN)('approval rules (PG-gated)', () => {
  test('APR-18: own marks in a row pass; a change by someone else is refused', async () => {
    const { a, b } = fix!;
    const sessionId = await seedOrder({ extras: 3, inRun: true });
    const seen = await lastSeqOf(sessionId);
    await a.caller.order.markExtraStatus({
      sessionId,
      extraIndex: 0,
      status: 'bought',
      expectedSeq: seen,
    });
    // Same page, second tap: only the caller's own mark is newer.
    await a.caller.order.markExtraStatus({
      sessionId,
      extraIndex: 1,
      status: 'bought',
      expectedSeq: seen,
    });
    // A repeat of a mark already made is a no-op, not a conflict.
    await a.caller.order.markExtraStatus({
      sessionId,
      extraIndex: 0,
      status: 'bought',
      expectedSeq: seen,
    });

    await b.caller.order.markExtraStatus({ sessionId, extraIndex: 2, status: 'unavailable' });
    const err = await errorOf(() =>
      a.caller.order.markExtraStatus({
        sessionId,
        extraIndex: 2,
        status: 'bought',
        expectedSeq: seen,
      }),
    );
    expect(err?.code).toBe('CONFLICT');
    expect(err?.message).toBe('order.errors.staleSeq');
    // An old client that sends no expectedSeq is not checked.
    await a.caller.order.markExtraStatus({ sessionId, extraIndex: 2, status: 'bought' });
  });

  test('RE-APR-2: of two approvers taking over at once, one gets it and the other is told', async () => {
    const { a, b, c, db } = fix!;
    const sessionId = await seedOrder({ claimedBy: a });
    const results = await Promise.allSettled([
      b.caller.order.takeOverClaim({ sessionId, fromMemberId: a.memberId }),
      c.caller.order.takeOverClaim({ sessionId, fromMemberId: a.memberId }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won.length).toBe(1);
    expect(lost.length).toBe(1);
    expect((lost[0]!.reason as Error).message).toBe('order.errors.alreadyClaimed');

    const [row] = await db
      .select({ claimedBy: s.orderSessionsV.claimedByMemberId })
      .from(s.orderSessionsV)
      .where(eq(s.orderSessionsV.id, sessionId));
    expect([b.memberId, c.memberId]).toContain(row!.claimedBy!);

    // The release says whose claim it ended.
    const releases = await db
      .select({ payload: s.events.payload })
      .from(s.events)
      .where(and(eq(s.events.streamId, sessionId), eq(s.events.type, 'ClaimReleased')))
      .orderBy(asc(s.events.seq));
    expect(releases.length).toBe(1);
    expect(releases[0]!.payload).toMatchObject({ reason: 'override', fromMemberId: a.memberId });
  });

  test("RE-APR-2: taking over a claim that has moved on, or one's own, writes nothing", async () => {
    const { a, b } = fix!;
    const sessionId = await seedOrder({ claimedBy: a });
    await b.caller.order.takeOverClaim({ sessionId, fromMemberId: a.memberId });
    // A's page still shows A's own claim being taken; A taps "take over"
    // from what it last saw — itself — and must not snatch it back.
    const stale = await errorOf(() =>
      a.caller.order.takeOverClaim({ sessionId, fromMemberId: a.memberId }),
    );
    expect(stale?.message).toBe('order.errors.alreadyClaimed');

    const before = await lastSeqOf(sessionId);
    const own = await b.caller.order.takeOverClaim({ sessionId });
    expect(own.lastSeq).toBe(before);
    expect(await lastSeqOf(sessionId)).toBe(before);
  });
});
