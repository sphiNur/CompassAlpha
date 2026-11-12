/**
 * Review ORD-26 (2026-11): the order page's banner for an order in a run
 * read the whole of run.get to say where the order had got to. It reads
 * run.storeProgress now, which must answer with run.get's checks and say
 * exactly what run.get says about that store: the run's status, the
 * store's splits (delivered / checked) and whether its delivery was
 * recalled. A reader of another store learns nothing more than run.get
 * tells them.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/run-store-progress.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb, schema as s } from '@compass/db';
import { ALL_PERMISSION_KEYS } from '@compass/db/seed-data';
import type { ActorCtx } from '@compass/domain/run';
import { appRouter } from '../trpc/router';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor } from './helpers/ctx';
import { seedMember, seedRoles, sessionOf } from './helpers/fixtures';
import { runStream, type RunStream } from './helpers/streams';
import { errorOf } from './helpers/errors';
import { cleanUpAfterAll, noteOrg } from './helpers/cleanup';

cleanUpAfterAll();

type Caller = ReturnType<typeof appRouter.createCaller>;
let fix: {
  storeA: string;
  storeB: string;
  skuId: string;
  run: RunStream;
  actor: ActorCtx;
  owner: Caller;
  staffA: Caller;
  /** Staff of a store the run does not serve. */
  staffC: Caller;
} | null = null;

const RUN_DATE = '2026-10-20';

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({
      slug: `progress-${suffix}`,
      name: 'Store progress',
      localeDefault: 'en',
      timezone: 'UTC',
    })
    .returning();
  noteOrg(org!.id);
  const orgId = org!.id;
  const roleIds = await seedRoles(db, orgId, ['super_admin', 'staff']);
  const store = async (name: string) =>
    (
      await db
        .insert(s.stores)
        .values({ orgId, name, code: `${name}-${suffix.slice(-6)}` })
        .returning()
    )[0]!.id;
  const storeA = await store('A');
  const storeB = await store('B');
  const storeC = await store('C');
  const [sku] = await db
    .insert(s.skus)
    .values({ orgId, code: `SP-${suffix.slice(-8)}`, names: { en: 'Rice' }, unit: 'kg', step: '1' })
    .returning();
  const skuId = sku!.id;

  const owner = await seedMember(db, orgId, {
    name: 'Progress owner',
    roles: [{ roleId: roleIds.super_admin! }],
  });
  const staff = async (storeId: string, n: number) =>
    callerFor(
      await sessionOf(
        orgId,
        await seedMember(db, orgId, {
          name: `Progress staff ${n}`,
          stores: [storeId],
          roles: [{ roleId: roleIds.staff!, storeId }],
        }),
      ),
    );

  // A run serving A and B, bought and out for delivery.
  const runId = randomUUID();
  const sessionIds = [randomUUID(), randomUUID()];
  for (const [i, storeId] of [storeA, storeB].entries()) {
    await db.insert(s.orderSessionsV).values({
      id: sessionIds[i]!,
      orgId,
      storeId,
      initiatedByMemberId: owner.memberId,
      orderDate: RUN_DATE,
      status: 'in_run',
      runId,
    });
  }
  const actor: ActorCtx = {
    userId: owner.userId,
    memberId: owner.memberId,
    permissions: new Set(ALL_PERMISSION_KEYS),
  };
  const run = runStream(orgId, runId);
  await run.exec({
    type: 'PlanRun',
    orgId,
    runDate: RUN_DATE,
    today: RUN_DATE,
    runIndex: 0,
    sessionIds,
    plannedItems: [{ skuId, qty: '4' }],
    actor,
  });
  await run.exec({ type: 'StartPurchase', actor });
  await run.exec({
    type: 'PurchaseItem',
    skuId,
    supplierId: null,
    unitPrice: '12000',
    actualQty: '4',
    receiptPhotoUrl: null,
    storeSplits: [
      { storeId: storeA, qty: '1' },
      { storeId: storeB, qty: '3' },
    ],
    paymentMethod: 'cash',
    actor,
  });
  await run.exec({ type: 'StartDelivery', actor });

  fix = {
    storeA,
    storeB,
    skuId,
    run,
    actor,
    owner: callerFor(await sessionOf(orgId, owner)),
    staffA: await staff(storeA, 1),
    staffC: await staff(storeC, 2),
  };
});

/** What run.get says about `storeId`, in run.storeProgress's shape. */
async function fromRunGet(caller: Caller, runId: string, storeId: string) {
  const run = await caller.run.get({ runId });
  return {
    status: run.status,
    splits: run.splits
      .filter((split) => split.storeId === storeId)
      .map((split) => ({
        storeId: split.storeId,
        deliveredAt: split.deliveredAt ? new Date(split.deliveredAt).toISOString() : null,
        confirmedAt: split.confirmedAt ? new Date(split.confirmedAt).toISOString() : null,
      })),
    recalledStoreIds: run.recalledStoreIds.filter((id) => id === storeId),
  };
}

describe.skipIf(!SHOULD_RUN)('run.storeProgress (PG-gated)', () => {
  test('says what run.get says about the store, through delivery, recall and check', async () => {
    const { storeA, storeB, skuId, run, actor, owner, staffA } = fix!;
    const runId = run.id;
    const same = async (caller: Caller, storeId: string) => {
      const progress = await caller.run.storeProgress({ runId, storeId });
      expect(progress).toEqual(await fromRunGet(caller, runId, storeId));
      return progress;
    };

    // Out for delivery, nothing delivered yet: "on the way".
    const onTheWay = await same(staffA, storeA);
    expect(onTheWay.status).toBe('delivering');
    expect(onTheWay.splits).toHaveLength(1);
    expect(onTheWay.splits[0]!.deliveredAt).toBeNull();
    await same(owner, storeA);

    await run.exec({ type: 'DeliverToStore', storeId: storeA, actor });
    const delivered = await same(staffA, storeA);
    expect(delivered.splits[0]!.deliveredAt).not.toBeNull();
    expect(delivered.splits[0]!.confirmedAt).toBeNull();
    expect(delivered.recalledStoreIds).toEqual([]);

    await run.exec({ type: 'UndeliverStore', storeId: storeA, reason: 'wrong store', actor });
    const recalled = await same(staffA, storeA);
    expect(recalled.recalledStoreIds).toEqual([storeA]);
    // The owner reads B's progress; A's recall is not B's.
    expect((await same(owner, storeB)).recalledStoreIds).toEqual([]);

    await run.exec({ type: 'DeliverToStore', storeId: storeA, actor });
    await run.exec({
      type: 'ConfirmStoreItem',
      storeId: storeA,
      skuId,
      status: 'ok',
      note: null,
      photoUrl: null,
      actor,
    });
    await run.exec({ type: 'ConfirmStore', storeId: storeA, actor });
    const checked = await same(staffA, storeA);
    expect(checked.recalledStoreIds).toEqual([]);
    expect(checked.splits[0]!.confirmedAt).not.toBeNull();
  });

  test("a store outside the reader's scope: nothing about it, as run.get", async () => {
    const { storeB, run, staffA } = fix!;
    const progress = await staffA.run.storeProgress({ runId: run.id, storeId: storeB });
    expect(progress).toEqual({ status: 'delivering', splits: [], recalledStoreIds: [] });
    expect(progress).toEqual(await fromRunGet(staffA, run.id, storeB));
  });

  test("a run that serves none of the reader's stores is not found, as run.get", async () => {
    const { storeA, run, staffC } = fix!;
    const progress = await errorOf(() =>
      staffC.run.storeProgress({ runId: run.id, storeId: storeA }),
    );
    expect(progress).toMatchObject({ code: 'NOT_FOUND', message: 'run.errors.notVisible' });
    expect(await errorOf(() => staffC.run.get({ runId: run.id }))).toMatchObject({
      code: 'NOT_FOUND',
      message: 'run.errors.notVisible',
    });
    expect(
      await errorOf(() => staffC.run.storeProgress({ runId: randomUUID(), storeId: storeA })),
    ).toMatchObject({ code: 'NOT_FOUND' });
  });
});
