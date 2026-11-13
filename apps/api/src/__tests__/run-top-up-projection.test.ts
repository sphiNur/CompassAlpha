/**
 * Review RUNAPI-12, part 3 (2026-11-13): each item's BUY-5 "still need X"
 * is kept in read_model.run_items_v.top_up_qty, and run.get reads it there
 * instead of replaying the run's stream. The answer must stay what the
 * stream says:
 *   - after every step of attach / purchase / revise / dismiss / undo /
 *     unavailable sequences, the column equals the reducer's topUpQty and
 *     run.get answers it;
 *   - a run whose column is not current (NULL from before migration 0073,
 *     or appended to without the projection) is answered from the stream,
 *     and its next event fills the column;
 *   - migration 0073 marks current exactly the runs with no attached
 *     sessions, and changes nothing when run again;
 *   - the recalled stores, now worked out in SQL, are those the stream says.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/run-top-up-projection.test.ts
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import { normalizeQty } from '@compass/contracts';
import { replayRun, type RunCommand } from '@compass/domain/run';
import { readRunEvents } from '../services/runStream';
import { loadSession } from '../trpc/context';
import { appRouter } from '../trpc/router';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor } from './helpers/ctx';
import { seedMember, seedRoles } from './helpers/fixtures';
import { planRun, runStream, type RunStream } from './helpers/streams';
import { rerunMigration } from './helpers/migrations';
import { cleanUpAfterAll, noteOrg } from './helpers/cleanup';

cleanUpAfterAll();

const MIGRATION = '0073_run_item_top_up.sql';
/** Its backfill: the tests' role does not own the tables it alters. */
const backfillOnly = (statement: string) => !statement.startsWith('ALTER TABLE');

interface Fixture {
  db: ReturnType<typeof getDb>;
  orgId: string;
  stores: [string, string];
  skus: [string, string, string, string];
  actor: { userId: string; memberId: string; permissions: ReadonlySet<string> };
  caller: ReturnType<typeof appRouter.createCaller>;
}
let fix: Fixture | null = null;

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug: `rtu-${suffix}`, name: 'Top-up column', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  const orgId = noteOrg(org!.id);
  const roleIds = await seedRoles(db, orgId, ['super_admin']);
  const stores: string[] = [];
  for (const name of ['A', 'B']) {
    const [store] = await db
      .insert(s.stores)
      .values({ orgId, name: `Top-up Store ${name}`, code: `${name}-${suffix.slice(-6)}` })
      .returning();
    stores.push(store!.id);
  }
  const skus: string[] = [];
  for (const name of ['Rice', 'Onion', 'Salt', 'Oil']) {
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
    name: 'Top-up buyer',
    stores,
    roles: [{ roleId: roleIds.super_admin!, storeId: null }],
  });
  const session = await loadSession(db, who.userId, orgId, who.memberId);
  if (!session) throw new Error('session failed to load');
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
        'run.finish',
        'delivery.dispatch',
        'delivery.confirm',
      ]),
    },
    caller: callerFor(session),
  };
});

/** One run may be planned or purchasing per org: cancel what a test left open. */
const opened: RunStream[] = [];
afterEach(async () => {
  for (const run of opened.splice(0)) {
    if (run.state.status === 'planned' || run.state.status === 'purchasing') {
      await run.exec({ type: 'CancelRun', reason: 'test done', actor: fix!.actor });
    }
  }
});

async function newRun(plannedItems: Array<{ skuId: string; qty: string }>): Promise<RunStream> {
  const run = runStream(fix!.orgId);
  opened.push(run);
  await planRun(run, fix!.orgId, { by: fix!.actor, sessionIds: [], plannedItems });
  return run;
}

const attach = (skuId: string, qty: string): RunCommand => ({
  type: 'AttachSessions',
  sessionIds: [randomUUID()],
  addedPlannedItems: [{ skuId, qty }],
  actor: fix!.actor,
});

const buy = (skuId: string, qty: string, storeId = fix!.stores[0]): RunCommand => ({
  type: 'PurchaseItem',
  skuId,
  supplierId: null,
  unitPrice: '1000',
  actualQty: qty,
  receiptPhotoUrl: null,
  storeSplits: [{ storeId, qty }],
  paymentMethod: 'cash',
  actor: fix!.actor,
});

const revise = (skuId: string, qty: string, unitPrice = '1000'): RunCommand => ({
  type: 'RevisePurchase',
  skuId,
  supplierId: null,
  unitPrice,
  actualQty: qty,
  receiptPhotoUrl: null,
  storeSplits: [{ storeId: fix!.stores[0], qty }],
  reason: 'top-up',
  paymentMethod: 'cash',
  actor: fix!.actor,
});

/** Each product's topUpQty as the stream says it (what run.get used to answer). */
async function streamTopUps(runId: string): Promise<Record<string, string | null>> {
  const state = replayRun(runId, await readRunEvents(fix!.db, runId));
  return Object.fromEntries(
    [...state.items.values()].map((item) => [item.skuId, item.topUpQty ?? null]),
  );
}

async function columnTopUps(runId: string): Promise<Record<string, string | null>> {
  const rows = await fix!.db
    .select({ skuId: s.runItemsV.skuId, topUpQty: s.runItemsV.topUpQty })
    .from(s.runItemsV)
    .where(eq(s.runItemsV.runId, runId));
  return Object.fromEntries(
    rows.map((row) => [row.skuId, row.topUpQty === null ? null : normalizeQty(row.topUpQty)]),
  );
}

async function seqs(runId: string) {
  const [row] = await fix!.db
    .select({ lastSeq: s.marketRunsV.lastSeq, topUpSeq: s.marketRunsV.topUpSeq })
    .from(s.marketRunsV)
    .where(eq(s.marketRunsV.id, runId));
  return row!;
}

async function answered(runId: string): Promise<Record<string, string | null>> {
  const run = await fix!.caller.run.get({ runId });
  expect(run).not.toHaveProperty('topUpSeq');
  return Object.fromEntries(run.items.map((item) => [item.skuId, item.topUpQty ?? null]));
}

/** The column is current and equals the stream; run.get answers the stream. */
async function expectCurrent(run: RunStream): Promise<void> {
  const expected = await streamTopUps(run.id);
  const { lastSeq, topUpSeq } = await seqs(run.id);
  expect(lastSeq).toBe(run.state.seq);
  expect(topUpSeq).toBe(lastSeq);
  expect(await columnTopUps(run.id)).toEqual(expected);
  expect(await answered(run.id)).toEqual(expected);
}

async function steps(run: RunStream, ...commands: RunCommand[]): Promise<void> {
  for (const command of commands) {
    await run.exec(command);
    await expectCurrent(run);
  }
}

describe.skipIf(!SHOULD_RUN)('run items top-up column (RUNAPI-12, PG-gated)', () => {
  test('attach, partial and full revisions, a price-only revision, re-attach', async () => {
    const [rice, onion] = fix!.skus;
    const run = await newRun([
      { skuId: rice, qty: '4' },
      { skuId: onion, qty: '1' },
    ]);
    await expectCurrent(run);
    await steps(
      run,
      { type: 'StartPurchase', actor: fix!.actor },
      // Pending: demand only grows the plan, no top-up.
      attach(onion, '0.5'),
      buy(rice, '4'),
      attach(rice, '2.5'),
      attach(rice, '0.25'),
      // Price only: nothing more bought, the top-up stays (RE-BUY-2).
      revise(rice, '4', '1100'),
      // Part of it bought.
      revise(rice, '5.5'),
      // Bought less than before: nothing counts against it.
      revise(rice, '5'),
      // The rest and more.
      revise(rice, '9'),
      attach(rice, '0.001'),
    );
    expect((await streamTopUps(run.id))[rice]).toBe('0.001');
  });

  test('dismiss, undo purchase, unavailable and unmark, a purchaser-added row, eject', async () => {
    const [rice, onion, salt, oil] = fix!.skus;
    const run = await newRun([
      { skuId: rice, qty: '2' },
      { skuId: onion, qty: '3' },
    ]);
    const late = randomUUID();
    await steps(
      run,
      { type: 'StartPurchase', actor: fix!.actor },
      buy(rice, '2'),
      attach(rice, '1'),
      { type: 'DismissTopUp', skuId: rice, note: 'enough', actor: fix!.actor },
      attach(rice, '1.2'),
      { type: 'UndoPurchase', skuId: rice, reason: '', actor: fix!.actor },
      buy(rice, '3.2'),
      { type: 'MarkUnavailable', skuId: onion, note: 'none left', actor: fix!.actor },
      attach(onion, '1'),
      { type: 'UnmarkUnavailable', skuId: onion, actor: fix!.actor },
      { type: 'MarkUnavailable', skuId: onion, note: 'none left', actor: fix!.actor },
      {
        type: 'AddPurchaserItem',
        skuId: salt,
        supplierId: null,
        unitPrice: '300',
        actualQty: '1',
        receiptPhotoUrl: null,
        storeSplits: [{ storeId: fix!.stores[1], qty: '1' }],
        paymentMethod: 'cash',
        reason: 'cheap today',
        runStoreIds: fix!.stores,
        actor: fix!.actor,
      },
      // RE-BUY-3: the purchaser's row becomes a demand row, already bought.
      attach(salt, '2'),
      {
        type: 'AttachSessions',
        sessionIds: [late],
        addedPlannedItems: [
          { skuId: oil, qty: '1' },
          { skuId: onion, qty: '0.5' },
        ],
        actor: fix!.actor,
      },
      {
        type: 'EjectSession',
        sessionId: late,
        removedPlannedItems: [{ skuId: oil, qty: '1' }],
        actor: fix!.actor,
      },
    );
    const topUps = await streamTopUps(run.id);
    expect(topUps[salt]).toBe('2');
    expect(topUps[onion]).toBe('0.5');
  });

  test('a run whose column is not current is answered from its stream, then filled', async () => {
    const { db, skus, actor } = fix!;
    const [rice, onion] = skus;
    const run = await newRun([
      { skuId: rice, qty: '2' },
      { skuId: onion, qty: '1' },
    ]);
    await steps(run, { type: 'StartPurchase', actor }, buy(rice, '2'), attach(rice, '1.5'));
    const expected = await streamTopUps(run.id);

    // As migration 0073 leaves a run with attached sessions.
    await db.update(s.runItemsV).set({ topUpQty: null }).where(eq(s.runItemsV.runId, run.id));
    await db.update(s.marketRunsV).set({ topUpSeq: null }).where(eq(s.marketRunsV.id, run.id));
    expect(await answered(run.id)).toEqual(expected);
    expect(await columnTopUps(run.id)).toEqual({ [rice]: null, [onion]: null });

    // Its next event fills it.
    await steps(run, buy(onion, '1'));
    expect((await columnTopUps(run.id))[rice]).toBe('1.5');

    // An event the projection did not see (the release before 0073 still
    // running): the column is left behind, run.get reads the stream.
    await run.exec(attach(rice, '1'));
    await db
      .update(s.marketRunsV)
      .set({ topUpSeq: run.state.seq - 1 })
      .where(eq(s.marketRunsV.id, run.id));
    await db
      .update(s.runItemsV)
      .set({ topUpQty: '1.5' })
      .where(and(eq(s.runItemsV.runId, run.id), eq(s.runItemsV.skuId, rice)));
    expect((await answered(run.id))[rice]).toBe('2.5');
    await steps(run, revise(rice, '3'));
    expect((await columnTopUps(run.id))[rice]).toBe('1.5');
  });

  test('migration 0073 marks current the runs with no attached sessions, once', async () => {
    const { db, skus, actor } = fix!;
    const [rice, onion] = skus;
    const plain = await newRun([{ skuId: rice, qty: '2' }]);
    await steps(plain, { type: 'StartPurchase', actor }, buy(rice, '2'));
    await plain.exec({ type: 'CancelRun', reason: 'done', actor });
    const attached = await newRun([{ skuId: onion, qty: '1' }]);
    await steps(attached, { type: 'StartPurchase', actor }, buy(onion, '1'), attach(onion, '2'));

    for (const run of [plain, attached]) {
      await db.update(s.runItemsV).set({ topUpQty: null }).where(eq(s.runItemsV.runId, run.id));
      await db.update(s.marketRunsV).set({ topUpSeq: null }).where(eq(s.marketRunsV.id, run.id));
    }
    await rerunMigration(MIGRATION, backfillOnly);
    expect(await seqs(plain.id)).toEqual({ lastSeq: plain.state.seq, topUpSeq: plain.state.seq });
    expect(await seqs(attached.id)).toEqual({ lastSeq: attached.state.seq, topUpSeq: null });
    // Still the stream's answer for the run it left alone.
    expect(await answered(attached.id)).toEqual(await streamTopUps(attached.id));
    expect((await answered(attached.id))[onion]).toBe('2');

    await rerunMigration(MIGRATION, backfillOnly);
    expect(await seqs(plain.id)).toEqual({ lastSeq: plain.state.seq, topUpSeq: plain.state.seq });
    expect(await seqs(attached.id)).toEqual({ lastSeq: attached.state.seq, topUpSeq: null });
    expect(await columnTopUps(plain.id)).toEqual({ [rice]: null });
  });

  test('recalled stores: the last delivery event per store, in first-named order', async () => {
    const { skus, stores, actor } = fix!;
    const [a, b] = stores;
    const [rice] = skus;
    const run = await newRun([{ skuId: rice, qty: '2' }]);
    await run.exec({ type: 'StartPurchase', actor });
    await run.exec({
      ...buy(rice, '2'),
      storeSplits: [
        { storeId: a, qty: '1' },
        { storeId: b, qty: '1' },
      ],
    } as RunCommand);
    await run.exec({ type: 'StartDelivery', actor });
    const recalled = async () => (await fix!.caller.run.get({ runId: run.id })).recalledStoreIds;
    expect(await recalled()).toEqual([]);
    await run.exec({ type: 'DeliverToStore', storeId: b, actor });
    await run.exec({ type: 'DeliverToStore', storeId: a, actor });
    await run.exec({ type: 'UndeliverStore', storeId: a, actor });
    expect(await recalled()).toEqual([a]);
    await run.exec({ type: 'UndeliverStore', storeId: b, actor });
    expect(await recalled()).toEqual([b, a]);
    await run.exec({ type: 'DeliverToStore', storeId: b, actor });
    expect(await recalled()).toEqual([a]);
    await run.exec({ type: 'DeliverToStore', storeId: a, actor });
    expect(await recalled()).toEqual([]);
  });
});
