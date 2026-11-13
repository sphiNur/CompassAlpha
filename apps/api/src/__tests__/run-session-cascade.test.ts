/**
 * What a run does to its order sessions, now services/runSessionCascade.ts
 * (review RUNAPI-13, 2026-11-12): a finish that cannot archive one of
 * them rolls back whole (M3.4), and an ejected session goes back to
 * approved with its own seq in the answer and the push.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/run-session-cascade.test.ts
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import type { RunCommand } from '@compass/domain/run';
import { appRouter } from '../trpc/router';
import { loadSession } from '../trpc/context';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor } from './helpers/ctx';
import { seedRoles, seedMember } from './helpers/fixtures';
import { planRun, runStream, seedOrder, type RunStream } from './helpers/streams';
import { errorOf } from './helpers/errors';
import { cleanUpAfterAll, noteOrg } from './helpers/cleanup';

cleanUpAfterAll();

interface Fixture {
  db: ReturnType<typeof getDb>;
  orgId: string;
  storeA: string;
  storeB: string;
  rice: string;
  caller: ReturnType<typeof appRouter.createCaller>;
  actor: { userId: string; memberId: string; permissions: ReadonlySet<string> };
}
let fix: Fixture | null = null;

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({
      slug: `rsc-${suffix}`,
      name: 'Session cascade',
      localeDefault: 'en',
      timezone: 'UTC',
    })
    .returning();
  const orgId = noteOrg(org!.id);
  const roleIds = await seedRoles(db, orgId, ['super_admin']);
  const storeIds: string[] = [];
  for (const name of ['A', 'B']) {
    const [store] = await db
      .insert(s.stores)
      .values({ orgId, name: `Smoke Store ${name}`, code: `${name}-${suffix.slice(-6)}` })
      .returning();
    storeIds.push(store!.id);
  }
  const [sku] = await db
    .insert(s.skus)
    .values({
      orgId,
      code: `Rice-${suffix.slice(-8)}`,
      names: { en: 'Rice' },
      unit: 'kg',
      step: '1',
    })
    .returning();
  const who = await seedMember(db, orgId, {
    name: 'Cascade admin',
    stores: storeIds,
    roles: [{ roleId: roleIds.super_admin!, storeId: null }],
  });
  const session = await loadSession(db, who.userId, orgId, who.memberId);
  if (!session) throw new Error('session failed to load');
  fix = {
    db,
    orgId,
    storeA: storeIds[0]!,
    storeB: storeIds[1]!,
    rice: sku!.id,
    caller: callerFor(session),
    actor: {
      userId: who.userId,
      memberId: who.memberId,
      permissions: new Set([
        'order.draft',
        'order.submit',
        'order.approve',
        'run.create',
        'run.purchase',
        'run.eject_session',
        'delivery.dispatch',
        'delivery.confirm',
      ]),
    },
  };
});

/** One run may be planned or purchasing per org: cancel a test's run after it. */
const opened: RunStream[] = [];
afterEach(async () => {
  for (const run of opened.splice(0)) {
    const [row] = await fix!.db
      .select({ status: s.marketRunsV.status })
      .from(s.marketRunsV)
      .where(eq(s.marketRunsV.id, run.id));
    if (row?.status === 'planned' || row?.status === 'purchasing') {
      await fix!.caller.run.cancel({ runId: run.id, reason: 'test done' });
    }
  }
});

function order(storeId: string, qty: string, until: 'submitted' | { runId: string }) {
  const { orgId, rice, actor } = fix!;
  return seedOrder(
    orgId,
    { ...actor, isClaimer: false },
    {
      storeId,
      items: [{ skuId: rice, qty }],
      until,
    },
  );
}

async function statusOf(sessionIds: string[]): Promise<Record<string, [string, number]>> {
  const rows = await fix!.db
    .select({
      id: s.orderSessionsV.id,
      status: s.orderSessionsV.status,
      lastSeq: s.orderSessionsV.lastSeq,
    })
    .from(s.orderSessionsV)
    .where(inArray(s.orderSessionsV.id, sessionIds));
  return Object.fromEntries(rows.map((row) => [row.id, [row.status, row.lastSeq]]));
}

describe.skipIf(!SHOULD_RUN)('run session cascade (RUNAPI-13, PG-gated)', () => {
  test('a finish that cannot archive one session rolls back whole', async () => {
    const { db, orgId, storeA, storeB, rice, caller, actor } = fix!;
    const run = runStream(orgId);
    opened.push(run);
    const inRun = await order(storeA, '2', { runId: run.id });
    // Listed by the run, yet never approved: the domain will not archive it.
    const submitted = await order(storeB, '1', 'submitted');
    await planRun(run, orgId, {
      by: actor,
      sessionIds: [inRun, submitted],
      plannedItems: [{ skuId: rice, qty: '3' }],
    });
    const commands: RunCommand[] = [
      { type: 'StartPurchase', actor },
      {
        type: 'PurchaseItem',
        skuId: rice,
        supplierId: null,
        unitPrice: '1000',
        actualQty: '3',
        receiptPhotoUrl: null,
        storeSplits: [
          { storeId: storeA, qty: '2' },
          { storeId: storeB, qty: '1' },
        ],
        paymentMethod: 'cash',
        actor,
      },
      { type: 'StartDelivery', actor },
    ];
    for (const storeId of [storeA, storeB]) {
      commands.push(
        { type: 'DeliverToStore', storeId, actor },
        { type: 'ConfirmStoreItemsOk', storeId, skuIds: [rice], actor },
        { type: 'ConfirmStore', storeId, actor },
      );
    }
    for (const command of commands) await run.exec(command);
    const before = await statusOf([inRun, submitted]);

    const refused = await errorOf(() => caller.run.finish({ runId: run.id }));
    expect(refused).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'run.errors.archiveCascadeFailed',
    });
    expect(refused!.cause).toMatchObject({
      runId: run.id,
      archiveFailures: [{ sessionId: submitted, reason: 'order.errors.cannotArchive' }],
    });
    // Nothing of the finish stays: the run is still out for delivery, and
    // the session archived before the refusal is in the run again.
    const [runRow] = await db
      .select({ status: s.marketRunsV.status, lastSeq: s.marketRunsV.lastSeq })
      .from(s.marketRunsV)
      .where(eq(s.marketRunsV.id, run.id));
    expect(runRow).toEqual({ status: 'delivering', lastSeq: run.state.seq });
    expect(await statusOf([inRun, submitted])).toEqual(before);
    expect(before[inRun]?.[0]).toBe('in_run');
  });

  test('an ejected session is approved again, and the answer carries its seq', async () => {
    const { db, orgId, storeA, storeB, rice, caller, actor } = fix!;
    const run = runStream(orgId);
    opened.push(run);
    const stays = await order(storeA, '2', { runId: run.id });
    const leaves = await order(storeB, '1', { runId: run.id });
    await planRun(run, orgId, {
      by: actor,
      sessionIds: [stays, leaves],
      plannedItems: [{ skuId: rice, qty: '3' }],
    });
    const answer = await caller.run.ejectSession({
      runId: run.id,
      sessionId: leaves,
      reason: 'ordered twice',
    });
    const after = await statusOf([stays, leaves]);
    expect(after[leaves]).toEqual(['approved', answer.orderLastSeq]);
    expect(after[stays]?.[0]).toBe('in_run');
    const [runRow] = await db
      .select({ sessionIds: s.marketRunsV.sessionIdsJson, lastSeq: s.marketRunsV.lastSeq })
      .from(s.marketRunsV)
      .where(eq(s.marketRunsV.id, run.id));
    expect(runRow).toEqual({ sessionIds: [stays], lastSeq: answer.lastSeq });
    const [item] = await db
      .select({ plannedQty: s.runItemsV.plannedQty })
      .from(s.runItemsV)
      .where(eq(s.runItemsV.runId, run.id));
    expect(item?.plannedQty).toBe('2.000');
  });
});
