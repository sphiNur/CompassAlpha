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
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb, schema as s } from '@compass/db';
import {
  apply as applyOrder,
  decide as decideOrder,
  emptyState as emptyOrderState,
} from '@compass/domain/order';
import {
  applyRun,
  decideRun,
  emptyRunState,
  type RunEvent,
} from '@compass/domain/run';
import { appendEvents } from '../services/eventStore';
import { projectOrder } from '../services/orderProjection';
import { projectRun } from '../services/runProjection';

(function loadEnv() {
  let dir = dirname(fileURLToPath(import.meta.url));
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

// Run only when DATABASE_URL is set AND points at a reachable host. We
// can't easily ping the DB synchronously here, so we treat localhost
// + a non-default port as a probable dev compose; if it's down, the
// test is skipped via SKIP_PG_TESTS=1 from the deploy script.
const SHOULD_RUN = !!process.env.DATABASE_URL && process.env.SKIP_PG_TESTS !== '1';

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
    const db = getDb();

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

    // tgUserId uniqueness: the disambiguator must TRAIL the timestamp, not
    // lead it. `Date.now()` is already 13 digits, so a leading `100`/`200`/
    // `300` prefix was sliced off by `.slice(-12)` — when these three inserts
    // landed in the same millisecond the three users collided on
    // users_tg_user_id_unique. A trailing 41/42/43 survives the slice and
    // keeps them distinct regardless of timing (matches the other PG tests).
    const [staffUser] = await db
      .insert(s.users)
      .values({ displayName: 'Staff', tgUserId: BigInt(`${Date.now()}41`.slice(-12)) })
      .returning();
    const [managerUser] = await db
      .insert(s.users)
      .values({ displayName: 'Manager', tgUserId: BigInt(`${Date.now()}42`.slice(-12)) })
      .returning();
    const [purchaserUser] = await db
      .insert(s.users)
      .values({ displayName: 'Purchaser', tgUserId: BigInt(`${Date.now()}43`.slice(-12)) })
      .returning();
    if (!staffUser || !managerUser || !purchaserUser) throw new Error('user inserts failed');

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
    let oState = emptyOrderState(sessionId);
    const staffActor = {
      userId: staffUser.id,
      memberId: staffMember.id,
      permissions: allPerms,
      isClaimer: false,
    };
    const start = decideOrder(oState, {
      type: 'StartDraft',
      orgId: org.id,
      storeId: store.id,
      orderDate: '2026-05-02',
      actor: staffActor,
    });
    for (const e of start) oState = applyOrder(oState, e);
    await appendEvents(db, {
      streamType: 'order',
      streamId: sessionId,
      orgId: org.id,
      events: start.map((e) => ({ ...e })),
    });
    await projectOrder(db, org.id, start);

    const adjust = decideOrder(oState, {
      type: 'AdjustItem',
      skuId: sku.id,
      qty: '5',
      sku: { id: sku.id, step: sku.step, unit: sku.unit, isArchived: false },
      actor: staffActor,
    });
    for (const e of adjust) oState = applyOrder(oState, e);
    await appendEvents(db, {
      streamType: 'order',
      streamId: sessionId,
      orgId: org.id,
      events: adjust.map((e) => ({ ...e })),
    });
    await projectOrder(db, org.id, adjust);

    const submit = decideOrder(oState, { type: 'Submit', actor: staffActor });
    for (const e of submit) oState = applyOrder(oState, e);
    await appendEvents(db, {
      streamType: 'order',
      streamId: sessionId,
      orgId: org.id,
      events: submit.map((e) => ({ ...e })),
    });
    await projectOrder(db, org.id, submit);

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
    const claim = decideOrder(oState, { type: 'Claim', actor: managerActor });
    for (const e of claim) oState = applyOrder(oState, e);
    await appendEvents(db, {
      streamType: 'order',
      streamId: sessionId,
      orgId: org.id,
      events: claim.map((e) => ({ ...e })),
    });
    await projectOrder(db, org.id, claim);

    const approve = decideOrder(oState, {
      type: 'Approve',
      actor: { ...managerActor, isClaimer: true },
    });
    for (const e of approve) oState = applyOrder(oState, e);
    await appendEvents(db, {
      streamType: 'order',
      streamId: sessionId,
      orgId: org.id,
      events: approve.map((e) => ({ ...e })),
    });
    await projectOrder(db, org.id, approve);

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
    let rState = emptyRunState(runId);
    const plan = decideRun(rState, {
      type: 'PlanRun',
      orgId: org.id,
      runDate: '2026-05-01',
      runIndex: 0,
      sessionIds: [sessionId],
      plannedItems: [{ skuId: sku.id, qty: '5' }],
      actor: purchaserActor,
    });
    for (const e of plan) rState = applyRun(rState, e);
    await appendEvents(db, {
      streamType: 'run',
      streamId: runId,
      orgId: org.id,
      events: plan.map((e) => ({ ...e })),
    });
    await projectRun(db, org.id, plan);

    const purchase = decideRun(rState, {
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
    for (const e of purchase) rState = applyRun(rState, e);
    await appendEvents(db, {
      streamType: 'run',
      streamId: runId,
      orgId: org.id,
      events: purchase.map((e) => ({ ...e })),
    });
    await projectRun(db, org.id, purchase);

    // Price history should have a row from the projection.
    const phRows = await db.query.priceHistory.findMany({
      where: (ph, { eq: eq2 }) => eq2(ph.skuId, sku.id),
    });
    expect(phRows.length).toBe(1);
    expect(phRows[0]!.unitPrice).toBe('15000.00');

    const startDeliver = decideRun(rState, { type: 'StartDelivery', actor: purchaserActor });
    for (const e of startDeliver) rState = applyRun(rState, e);
    await appendEvents(db, {
      streamType: 'run',
      streamId: runId,
      orgId: org.id,
      events: startDeliver.map((e) => ({ ...e })),
    });
    await projectRun(db, org.id, startDeliver);

    const deliver = decideRun(rState, {
      type: 'DeliverToStore',
      storeId: store.id,
      actor: purchaserActor,
    });
    for (const e of deliver) rState = applyRun(rState, e);
    await appendEvents(db, {
      streamType: 'run',
      streamId: runId,
      orgId: org.id,
      events: deliver.map((e) => ({ ...e })),
    });
    await projectRun(db, org.id, deliver);

    // ---- Stage 4: store confirms ----
    const staffConfirmActor = {
      userId: staffUser.id,
      memberId: staffMember.id,
      permissions: allPerms,
    };
    const confirmItem = decideRun(rState, {
      type: 'ConfirmStoreItem',
      storeId: store.id,
      skuId: sku.id,
      status: 'ok',
      note: null,
      photoUrl: null,
      actor: staffConfirmActor,
    });
    for (const e of confirmItem) rState = applyRun(rState, e);
    await appendEvents(db, {
      streamType: 'run',
      streamId: runId,
      orgId: org.id,
      events: confirmItem.map((e) => ({ ...e })),
    });
    await projectRun(db, org.id, confirmItem);

    const confirmStore = decideRun(rState, {
      type: 'ConfirmStore',
      storeId: store.id,
      actor: staffConfirmActor,
    });
    for (const e of confirmStore) rState = applyRun(rState, e);
    await appendEvents(db, {
      streamType: 'run',
      streamId: runId,
      orgId: org.id,
      events: confirmStore.map((e) => ({ ...e })),
    });
    await projectRun(db, org.id, confirmStore);

    // ---- Stage 5: finish ----
    const finish = decideRun(rState, { type: 'FinishRun', actor: purchaserActor });
    for (const e of finish) rState = applyRun(rState, e);
    await appendEvents(db, {
      streamType: 'run',
      streamId: runId,
      orgId: org.id,
      events: finish.map((e) => ({ ...e })),
    });
    await projectRun(db, org.id, finish);

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

    // ---- Replay determinism: drop read model rows for this run + replay ----
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
    const rebuilt = await db.query.marketRunsV.findFirst({
      where: (r, { eq: eq2 }) => eq2(r.id, runId),
    });
    expect(rebuilt?.status).toBe('finished');
    expect(rebuilt?.actualTotal).toBe('75000.00');
  });
});

