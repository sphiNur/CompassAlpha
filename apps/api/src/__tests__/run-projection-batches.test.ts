/**
 * The run projection writes a purchase's store splits, and takes an
 * ejected session's demand out of the plan, one statement at a time
 * (review RUNAPI-21, 2026-11-12): each store split was an upsert of its
 * own, and each ejected product a read followed by an update or a
 * delete. The rows must come out as before: as the run's own state says.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/run-projection-batches.test.ts
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import { normalizeQty } from '@compass/contracts';
import type { RunCommand, RunEvent, RunState } from '@compass/domain/run';
import { SHOULD_RUN } from './helpers/pg';
import { seedRoles, seedMember } from './helpers/fixtures';
import { planRun, runStream, type RunStream } from './helpers/streams';
import { cleanUpAfterAll, noteOrg } from './helpers/cleanup';

cleanUpAfterAll();

interface Fixture {
  db: ReturnType<typeof getDb>;
  orgId: string;
  stores: [string, string, string];
  skus: [string, string, string, string, string];
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
      slug: `rpb-${suffix}`,
      name: 'Projection batches',
      localeDefault: 'en',
      timezone: 'UTC',
    })
    .returning();
  const orgId = noteOrg(org!.id);
  const roleIds = await seedRoles(db, orgId, ['super_admin']);
  const stores: string[] = [];
  for (const name of ['A', 'B', 'C']) {
    const [store] = await db
      .insert(s.stores)
      .values({ orgId, name: `Smoke Store ${name}`, code: `${name}-${suffix.slice(-6)}` })
      .returning();
    stores.push(store!.id);
  }
  const skus: string[] = [];
  for (const name of ['Rice', 'Onion', 'Salt', 'Flour', 'Oil']) {
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
    skus.push(sku!.id);
  }
  const who = await seedMember(db, orgId, {
    name: 'Projection buyer',
    stores,
    roles: [{ roleId: roleIds.super_admin!, storeId: null }],
  });
  fix = {
    db,
    orgId,
    stores: stores as Fixture['stores'],
    skus: skus as Fixture['skus'],
    actor: {
      userId: who.userId,
      memberId: who.memberId,
      permissions: new Set([
        'run.create',
        'run.purchase',
        'run.eject_session',
        'delivery.dispatch',
        'delivery.confirm',
      ]),
    },
  };
});

/** The runs a test made: one run may be planned or purchasing per org. */
const opened: RunStream[] = [];
afterEach(async () => {
  for (const run of opened.splice(0)) {
    if (run.state.status === 'planned' || run.state.status === 'purchasing') {
      await run.exec({ type: 'CancelRun', reason: 'test done', actor: fix!.actor });
    }
  }
});

async function newRun(
  plannedItems: Array<{ skuId: string; qty: string }>,
  sessionIds: string[] = [],
) {
  const run = runStream(fix!.orgId);
  opened.push(run);
  await planRun(run, fix!.orgId, { by: fix!.actor, sessionIds, plannedItems });
  return run;
}

async function exec(run: RunStream, ...commands: RunCommand[]): Promise<void> {
  for (const command of commands) await run.exec(command);
}

/** The next event of `run`, written as an older stream may hold it. */
function nextEvent<T extends RunEvent['type']>(
  run: RunStream,
  type: T,
  payload: Extract<RunEvent, { type: T }>['payload'],
): RunEvent {
  return {
    streamId: run.id,
    seq: run.state.seq + 1,
    occurredAt: new Date(),
    actorUserId: fix!.actor.userId,
    actorMemberId: fix!.actor.memberId,
    type,
    payload,
  } as RunEvent;
}

async function splitRows(runId: string) {
  const rows = await fix!.db
    .select()
    .from(s.runItemStoresV)
    .where(eq(s.runItemStoresV.runId, runId));
  return rows.sort((a, b) => `${a.skuId}|${a.storeId}`.localeCompare(`${b.skuId}|${b.storeId}`));
}

/** A product's split rows by store: [qty, unit price, payment]. */
async function splitsOf(runId: string, skuId: string) {
  const rows = (await splitRows(runId)).filter((row) => row.skuId === skuId);
  return Object.fromEntries(
    rows.map((row) => [row.storeId, [row.qty, row.unitPrice, row.paymentMethod]]),
  );
}

async function plannedQtys(runId: string): Promise<Record<string, string>> {
  const rows = await fix!.db
    .select({ skuId: s.runItemsV.skuId, plannedQty: s.runItemsV.plannedQty })
    .from(s.runItemsV)
    .where(eq(s.runItemsV.runId, runId));
  return Object.fromEntries(rows.map((row) => [row.skuId, normalizeQty(row.plannedQty)]));
}

/** What the run's state says the split rows are: one per (product, store). */
function stateSplits(state: RunState) {
  const out: Array<{ skuId: string; storeId: string; qty: string }> = [];
  for (const item of state.items.values()) {
    const byStore = new Map(item.storeSplits.map((split) => [split.storeId, split.qty]));
    for (const [storeId, qty] of byStore) out.push({ skuId: item.skuId, storeId, qty });
  }
  return out.sort((a, b) => `${a.skuId}|${a.storeId}`.localeCompare(`${b.skuId}|${b.storeId}`));
}

function statePlanned(state: RunState): Record<string, string> {
  return Object.fromEntries(
    [...state.items.values()].map((item) => [item.skuId, normalizeQty(item.plannedQty)]),
  );
}

describe.skipIf(!SHOULD_RUN)('run projection batches (RUNAPI-21, PG-gated)', () => {
  test('a purchase writes its store splits; a revision drops, keeps and adds stores', async () => {
    const { stores, skus, actor } = fix!;
    const [a, b, c] = stores;
    const run = await newRun([{ skuId: skus[0], qty: '5' }]);
    await exec(
      run,
      { type: 'StartPurchase', actor },
      {
        type: 'PurchaseItem',
        skuId: skus[0],
        supplierId: null,
        unitPrice: '1000',
        actualQty: '5',
        receiptPhotoUrl: null,
        storeSplits: [
          { storeId: a, qty: '2', unitPrice: '900', paymentMethod: 'transfer' },
          { storeId: b, qty: '3' },
        ],
        paymentMethod: 'cash',
        actor,
      },
    );
    expect(await splitsOf(run.id, skus[0])).toEqual({
      [a]: ['2.000', '900.00', 'transfer'],
      [b]: ['3.000', null, null],
    });

    // B off the line, A changed, C new.
    await exec(run, {
      type: 'RevisePurchase',
      skuId: skus[0],
      supplierId: null,
      unitPrice: '1000',
      actualQty: '5',
      receiptPhotoUrl: null,
      storeSplits: [
        { storeId: a, qty: '1' },
        { storeId: c, qty: '4', unitPrice: '950', paymentMethod: 'transfer' },
      ],
      reason: 'moved to C',
      paymentMethod: 'cash',
      actor,
    });
    expect(await splitsOf(run.id, skus[0])).toEqual({
      [a]: ['1.000', null, null],
      [c]: ['4.000', '950.00', 'transfer'],
    });
    expect(
      (await splitRows(run.id)).map(({ skuId, storeId, qty }) => ({
        skuId,
        storeId,
        qty: normalizeQty(qty),
      })),
    ).toEqual(stateSplits(run.state));
  });

  test('a kept store keeps its delivery when the price is corrected after it', async () => {
    const { stores, skus, actor } = fix!;
    const [a, b] = stores;
    const run = await newRun([{ skuId: skus[1], qty: '4' }]);
    await exec(
      run,
      { type: 'StartPurchase', actor },
      {
        type: 'PurchaseItem',
        skuId: skus[1],
        supplierId: null,
        unitPrice: '500',
        actualQty: '4',
        receiptPhotoUrl: null,
        storeSplits: [
          { storeId: a, qty: '1' },
          { storeId: b, qty: '3' },
        ],
        paymentMethod: 'cash',
        actor,
      },
      { type: 'StartDelivery', actor },
      { type: 'DeliverToStore', storeId: a, actor },
    );
    const before = (await splitRows(run.id)).find((row) => row.storeId === a)!;
    expect(before.deliveredAt).not.toBeNull();
    await exec(run, {
      type: 'RevisePurchase',
      skuId: skus[1],
      supplierId: null,
      unitPrice: '550',
      actualQty: '4',
      receiptPhotoUrl: null,
      storeSplits: [
        { storeId: a, qty: '1', unitPrice: '560' },
        { storeId: b, qty: '3' },
      ],
      reason: 'price typed late',
      paymentMethod: 'cash',
      actor,
    });
    const after = await splitRows(run.id);
    const rowA = after.find((row) => row.storeId === a)!;
    expect(rowA.deliveredAt?.toISOString()).toBe(before.deliveredAt!.toISOString());
    expect(rowA.deliveredByUserId).toBe(actor.userId);
    expect(rowA.unitPrice).toBe('560.00');
    expect(after.find((row) => row.storeId === b)!.deliveredAt).toBeNull();
  });

  test('a store named twice in an older event keeps its last split', async () => {
    const { stores, skus, actor } = fix!;
    const [a, b] = stores;
    const run = await newRun([{ skuId: skus[2], qty: '3' }]);
    await exec(run, { type: 'StartPurchase', actor });
    await run.write([
      nextEvent(run, 'ItemPurchased', {
        skuId: skus[2],
        supplierId: null,
        unitPrice: '100',
        actualQty: '3',
        receiptPhotoUrl: null,
        storeSplits: [
          { storeId: a, qty: '1', unitPrice: '90' },
          { storeId: b, qty: '1' },
          { storeId: a, qty: '1', paymentMethod: 'transfer' },
        ],
        paymentMethod: 'cash',
      }),
    ]);
    expect(await splitsOf(run.id, skus[2])).toEqual({
      [a]: ['1.000', null, 'transfer'],
      [b]: ['1.000', null, null],
    });
  });

  test("an ejected session's demand leaves the plan in whole thousandths", async () => {
    const { db, stores, skus, actor } = fix!;
    const [a] = stores;
    const [rice, onion, salt, flour, oil] = skus;
    const sessions = [randomUUID(), randomUUID()];
    const run = await newRun(
      [
        { skuId: rice, qty: '5' },
        { skuId: onion, qty: '2' },
        { skuId: salt, qty: '1' },
        { skuId: oil, qty: '0.3' },
      ],
      sessions,
    );
    // Rows an older stream can leave: a split of a product still in the
    // plan, and one of a product that is not (flour has no item row).
    await db.insert(s.runItemStoresV).values([
      { runId: run.id, skuId: rice, storeId: a, qty: '5' },
      { runId: run.id, skuId: onion, storeId: a, qty: '2' },
      { runId: run.id, skuId: flour, storeId: a, qty: '1' },
    ]);
    await run.write([
      nextEvent(run, 'SessionEjectedFromRun', {
        sessionId: sessions[0]!,
        removedPlannedItems: [
          { skuId: rice, qty: '1.5' },
          { skuId: onion, qty: '2' },
          { skuId: flour, qty: '1' },
          { skuId: rice, qty: '0.5' },
          // Float noise from before RUNAPI-05: reads as 0.3.
          { skuId: oil, qty: '0.30000000000000004' },
        ],
        reason: null,
        byMemberId: actor.memberId,
      }),
    ]);
    expect(await plannedQtys(run.id)).toEqual({ [rice]: '3', [salt]: '1' });
    expect(await plannedQtys(run.id)).toEqual(statePlanned(run.state));
    expect((await splitRows(run.id)).map((row) => [row.skuId, row.qty])).toEqual([[rice, '5.000']]);
    const [runRow] = await db
      .select({ sessionIds: s.marketRunsV.sessionIdsJson, lastSeq: s.marketRunsV.lastSeq })
      .from(s.marketRunsV)
      .where(eq(s.marketRunsV.id, run.id));
    expect(runRow).toEqual({ sessionIds: [sessions[1]!], lastSeq: run.state.seq });

    // The domain's own EjectSession, on demand attached later.
    const third = randomUUID();
    await run.write([
      nextEvent(run, 'SessionsAttachedToRun', {
        sessionIds: [third],
        addedPlannedItems: [{ skuId: salt, qty: '2' }],
      }),
    ]);
    expect(await plannedQtys(run.id)).toEqual({ [rice]: '3', [salt]: '3' });
    await exec(run, {
      type: 'EjectSession',
      sessionId: third,
      removedPlannedItems: [{ skuId: salt, qty: '2' }],
      actor,
    });
    expect(await plannedQtys(run.id)).toEqual({ [rice]: '3', [salt]: '1' });
    expect(await plannedQtys(run.id)).toEqual(statePlanned(run.state));
  });
});
