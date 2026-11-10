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
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import { type RunCommand } from '@compass/domain/run';
import { appRouter } from '../trpc/router';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor } from './helpers/ctx';
import { seedRoles, seedMember, sessionOf } from './helpers/fixtures';
import { planRun, runStream, seedOrder } from './helpers/streams';
import { errorOf } from './helpers/errors';

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

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug: `rules-${suffix}`, name: 'Server rules', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  const orgId = org!.id;
  const roleId = (await seedRoles(db, orgId, ['super_admin'])).super_admin!;
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
    const who = await seedMember(db, orgId, {
      name: `Rules ${n}`,
      stores: [store!.id],
      roles: [{ roleId }],
    });
    return {
      caller: callerFor(await sessionOf(orgId, who)),
      userId: who.userId,
      memberId: who.memberId,
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

/** A run delivered to the store, both products split to it (2 kg each). */
async function deliveredRun(): Promise<string> {
  const { orgId, storeId, skuIds, a } = fix!;
  const run = runStream(orgId);
  await planRun(run, orgId, {
    by: a,
    sessionIds: [],
    plannedItems: skuIds.map((skuId) => ({ skuId, qty: '2' })),
  });
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
  for (const cmd of cmds) await run.exec(cmd);
  return run.id;
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

/** A submitted order of person `c`, optionally claimed and carried into a run. */
function storeOrder(opts: {
  claimedBy?: Person;
  extras?: number;
  inRun?: boolean;
}): Promise<string> {
  const { orgId, storeId, skuIds, c } = fix!;
  return seedOrder(orgId, orderActorOf(c), {
    storeId,
    items: [{ skuId: skuIds[0], qty: '1' }],
    extras: opts.extras,
    claimedBy: opts.claimedBy ? orderActorOf(opts.claimedBy) : undefined,
    until: opts.inRun ? { runId: randomUUID() } : 'submitted',
  });
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
    const sessionId = await storeOrder({ extras: 3, inRun: true });
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
    const sessionId = await storeOrder({ claimedBy: a });
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
    const sessionId = await storeOrder({ claimedBy: a });
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
