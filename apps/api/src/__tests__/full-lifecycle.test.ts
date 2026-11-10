/**
 * End-to-end lifecycle test against a real Postgres.
 *
 * Drives the event-sourced flow from outside the tRPC layer (we call
 * the same decide() + projector code paths the routers use). This
 * catches bugs that the pure-domain tests miss: schema drift,
 * projection divergence, RLS breakage, replay determinism.
 *
 * Requirements to run:
 *   - DATABASE_URL pointing at a Postgres with the full schema applied.
 *     Locally that's `compose up postgres` + `pnpm db:migrate`.
 *
 * Idempotency:
 *   - Each test run uses a unique org slug + sku codes prefixed with
 *     a timestamp so back-to-back runs don't collide.
 *   - We don't bother cleaning up; rows are tagged `slug LIKE 'lifecycle-%'`.
 *
 * Skipped (not failed) when DATABASE_URL is unset, e.g. in fast unit-test
 * runs.
 */
import { describe, expect, test } from 'bun:test';
import { asc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb, schema as s } from '@compass/db';
import { decideRun, type RunEvent } from '@compass/domain/run';
import { projectRun } from '../services/runProjection';
import { loadSkuPriceStats } from '../services/priceStats';
import { SHOULD_RUN } from './helpers/pg';
import { freshTgId } from './helpers/telegram';
import { orderStream, runStream } from './helpers/streams';
import { cleanUpAfterAll, noteOrg, noteUser } from './helpers/cleanup';

cleanUpAfterAll();

// Run only when DATABASE_URL is set AND points at a reachable host. We
// can't easily ping the DB synchronously here, so we treat localhost
// + a non-default port as a probable dev compose; if it's down, the
// test is skipped via SKIP_PG_TESTS=1 from the deploy script.

const fixtureSlug = `lifecycle-${Date.now()}`;
const allPerms = new Set([
  'order.draft',
  'order.submit',
  'order.approve',
  'order.claim',
  'run.create',
  'run.purchase',
  'delivery.dispatch',
  'delivery.confirm',
  'run.finish',
]);

describe('full lifecycle (PG)', () => {
  test.skipIf(!SHOULD_RUN)('order → submit → claim → approve → run → purchase → deliver → confirm → finish', async () => {
    const db = getDb(undefined, { system: 'maintenance' });

    // ---- Setup org + members + skus + store ----
    const [org] = await db
      .insert(s.organizations)
      .values({
        slug: fixtureSlug,
        name: 'Lifecycle Test Org',
        localeDefault: 'en',
        timezone: 'UTC',
      })
      .returning();
    if (!org) throw new Error('failed to insert org');
    noteOrg(org.id);

    const [staffUser] = await db
      .insert(s.users)
      .values({ displayName: 'Staff', tgUserId: freshTgId() })
      .returning();
    const [managerUser] = await db
      .insert(s.users)
      .values({ displayName: 'Manager', tgUserId: freshTgId() })
      .returning();
    const [purchaserUser] = await db
      .insert(s.users)
      .values({ displayName: 'Purchaser', tgUserId: freshTgId() })
      .returning();
    if (!staffUser || !managerUser || !purchaserUser) throw new Error('user inserts failed');
    noteUser(staffUser.id);
    noteUser(managerUser.id);
    noteUser(purchaserUser.id);

    const [staffMember] = await db
      .insert(s.members)
      .values({ orgId: org.id, userId: staffUser.id })
      .returning();
    const [managerMember] = await db
      .insert(s.members)
      .values({ orgId: org.id, userId: managerUser.id })
      .returning();
    const [purchaserMember] = await db
      .insert(s.members)
      .values({ orgId: org.id, userId: purchaserUser.id })
      .returning();
    if (!staffMember || !managerMember || !purchaserMember) throw new Error('member inserts failed');

    const [store] = await db
      .insert(s.stores)
      .values({ orgId: org.id, name: 'Test Store', code: 'TEST-' + fixtureSlug.slice(-6) })
      .returning();
    if (!store) throw new Error('store insert failed');

    const [sku] = await db
      .insert(s.skus)
      .values({
        orgId: org.id,
        code: 'BEEF-' + fixtureSlug.slice(-6),
        names: { en: 'Beef' },
        unit: 'kg',
        step: '0.5',
      })
      .returning();
    if (!sku) throw new Error('sku insert failed');

    // ---- Stage 1: staff drafts an order ----
    const sessionId = randomUUID();
    const orderLog = orderStream(org.id, sessionId);
    const staffActor = {
      userId: staffUser.id,
      memberId: staffMember.id,
      permissions: allPerms,
      isClaimer: false,
    };
    await orderLog.exec({
      type: 'StartDraft',
      orgId: org.id,
      storeId: store.id,
      orderDate: '2026-05-02',
      actor: staffActor,
    });

    await orderLog.exec({
      type: 'AdjustItem',
      skuId: sku.id,
      qty: '5',
      sku: { id: sku.id, step: sku.step, unit: sku.unit, isArchived: false },
      actor: staffActor,
    });

    await orderLog.exec({ type: 'Submit', actor: staffActor });

    // Verify projection.
    const submitted = await db.query.orderSessionsV.findFirst({
      where: (sess, { eq: eq2 }) => eq2(sess.id, sessionId),
    });
    expect(submitted?.status).toBe('submitted');

    // ---- Stage 2: manager claims + approves ----
    const managerActor = {
      userId: managerUser.id,
      memberId: managerMember.id,
      permissions: allPerms,
      isClaimer: false,
    };
    await orderLog.exec({ type: 'Claim', actor: managerActor });

    await orderLog.exec({
      type: 'Approve',
      actor: { ...managerActor, isClaimer: true },
    });

    const approved = await db.query.orderSessionsV.findFirst({
      where: (sess, { eq: eq2 }) => eq2(sess.id, sessionId),
    });
    expect(approved?.status).toBe('approved');
    expect(approved?.claimedByMemberId).toBeNull();

    // ---- Stage 3: purchaser plans run + buys + delivers + finishes ----
    const purchaserActor = {
      userId: purchaserUser.id,
      memberId: purchaserMember.id,
      permissions: allPerms,
    };
    const runId = randomUUID();
    const runLog = runStream(org.id, runId);
    await runLog.exec({
      type: 'PlanRun',
      orgId: org.id,
      runDate: '2026-05-01',
      runIndex: 0,
      sessionIds: [sessionId],
      plannedItems: [{ skuId: sku.id, qty: '5' }],
      actor: purchaserActor,
    });

    await runLog.exec({
      type: 'PurchaseItem',
      skuId: sku.id,
      supplierId: null,
      unitPrice: '15000',
      actualQty: '5',
      receiptPhotoUrl: null,
      storeSplits: [{ storeId: store.id, qty: '5' }],
      paymentMethod: 'cash',
      actor: purchaserActor,
    });

    // Price history should have a row from the projection.
    const phRows = await db.query.priceHistory.findMany({
      where: (ph, { eq: eq2 }) => eq2(ph.skuId, sku.id),
    });
    expect(phRows.length).toBe(1);
    expect(phRows[0]!.unitPrice).toBe('15000.00');

    // A price typed in the wrong unit and then corrected must not stay
    // in what the product is taken to cost. The mistake is kept as a
    // row, marked; only the correction counts.
    const run = async (command: Parameters<typeof decideRun>[1]): Promise<void> => {
      await runLog.exec(command);
    };
    const correction = {
      type: 'RevisePurchase' as const,
      skuId: sku.id,
      supplierId: null,
      actualQty: '5',
      receiptPhotoUrl: null,
      storeSplits: [{ storeId: store.id, qty: '5' }],
      paymentMethod: 'cash' as const,
      actor: purchaserActor,
    };
    await run({ ...correction, unitPrice: '15000000', reason: 'typed in the wrong unit' });
    await run({ ...correction, unitPrice: '15000', reason: 'and back' });
    const afterFix = await db.query.priceHistory.findMany({
      where: (ph, { eq: eq2 }) => eq2(ph.skuId, sku.id),
    });
    expect(afterFix.length).toBe(3);
    const current = afterFix.filter((row) => row.supersededAt === null);
    expect(current.map((row) => row.unitPrice)).toEqual(['15000.00']);
    const stats = await loadSkuPriceStats(db, org.id, [sku.id]);
    expect(stats.get(sku.id)?.lastPrice).toBe('15000.00');
    expect(stats.get(sku.id)?.avg7d).toBe(15000);
    expect(stats.get(sku.id)?.observations30d).toBe(1);

    // Taking the purchase back leaves no price at all; buying again does.
    await run({ type: 'UndoPurchase', skuId: sku.id, reason: 'wrong stall', actor: purchaserActor });
    expect((await loadSkuPriceStats(db, org.id, [sku.id])).get(sku.id)).toBeUndefined();
    await run({
      type: 'PurchaseItem',
      skuId: sku.id,
      supplierId: null,
      unitPrice: '15000',
      actualQty: '5',
      receiptPhotoUrl: null,
      storeSplits: [{ storeId: store.id, qty: '5' }],
      paymentMethod: 'cash',
      actor: purchaserActor,
    });
    expect((await loadSkuPriceStats(db, org.id, [sku.id])).get(sku.id)?.lastPrice).toBe('15000.00');

    await runLog.exec({ type: 'StartDelivery', actor: purchaserActor });

    await runLog.exec({
      type: 'DeliverToStore',
      storeId: store.id,
      actor: purchaserActor,
    });

    // ---- Stage 4: store confirms ----
    const staffConfirmActor = {
      userId: staffUser.id,
      memberId: staffMember.id,
      permissions: allPerms,
    };
    await runLog.exec({
      type: 'ConfirmStoreItem',
      storeId: store.id,
      skuId: sku.id,
      status: 'ok',
      note: null,
      photoUrl: null,
      actor: staffConfirmActor,
    });

    await runLog.exec({
      type: 'ConfirmStore',
      storeId: store.id,
      actor: staffConfirmActor,
    });

    // ---- Stage 5: finish ----
    await runLog.exec({ type: 'FinishRun', actor: purchaserActor });

    const finalRun = await db.query.marketRunsV.findFirst({
      where: (r, { eq: eq2 }) => eq2(r.id, runId),
    });
    expect(finalRun?.status).toBe('finished');
    expect(finalRun?.actualTotal).toBe('75000.00'); // 5 × 15000

    const finalSplit = await db.query.runItemStoresV.findFirst({
      where: (sp, { eq: eq2, and }) => and(eq2(sp.runId, runId), eq2(sp.storeId, store.id)),
    });
    expect(finalSplit?.confirmStatus).toBe('ok');
    expect(finalSplit?.confirmedAt).not.toBeNull();

    // ---- Replay determinism: the read model rebuilt from the events alone
    // is the one the commands wrote: the run, its items and their splits.
    // A run's and an item's updatedAt say when the row was last projected,
    // so a replay moves them.
    const projected = <Row extends { updatedAt: Date }>(rows: Row[]) =>
      rows.map(({ updatedAt: _projectedAt, ...row }) => row);
    const readModel = async () => ({
      run: projected(await db.select().from(s.marketRunsV).where(eq(s.marketRunsV.id, runId))),
      items: projected(
        await db
          .select()
          .from(s.runItemsV)
          .where(eq(s.runItemsV.runId, runId))
          .orderBy(asc(s.runItemsV.skuId)),
      ),
      splits: await db
        .select()
        .from(s.runItemStoresV)
        .where(eq(s.runItemStoresV.runId, runId))
        .orderBy(asc(s.runItemStoresV.skuId), asc(s.runItemStoresV.storeId)),
    });
    const written = await readModel();
    expect(written.items.length).toBeGreaterThan(0);
    expect(written.splits.length).toBeGreaterThan(0);
    await db.delete(s.runItemsV).where(eq(s.runItemsV.runId, runId));
    await db.delete(s.runItemStoresV).where(eq(s.runItemStoresV.runId, runId));
    await db.delete(s.marketRunsV).where(eq(s.marketRunsV.id, runId));
    const allEvents = await db.query.events.findMany({
      where: (ev, { eq: eq2, and }) => and(eq2(ev.streamId, runId), eq2(ev.streamType, 'run')),
      orderBy: (ev, { asc }) => asc(ev.seq),
    });
    const replayed: RunEvent[] = allEvents.map((row) => ({
      ...(row.payload as Record<string, unknown>),
      type: row.type,
      seq: row.seq,
      streamId: row.streamId,
      occurredAt: row.occurredAt,
      actorUserId: row.actorId ?? null,
      actorMemberId: null,
      payload: row.payload,
    } as unknown as RunEvent));
    await projectRun(db, org.id, replayed);
    expect(await readModel()).toEqual(written);
  });
});

