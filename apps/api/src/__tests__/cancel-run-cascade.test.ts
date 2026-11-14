/**
 * Cancel-run cascade integration test (M1.9, 2026-05-07).
 *
 * The pre-launch readiness audit flagged this as a CRITICAL untested
 * path. Specifically the M1.7-fix in `run.cancel` (routers/run/plan.ts) synthesizes the
 * `run.eject_session` permission when cascading EjectFromRun events
 * during cancel. Without that synthesis, an actor with `run.create`
 * (the perm gating cancel) but WITHOUT `run.eject_session` would
 * succeed at marking the run cancelled but silently fail to detach
 * sessions — leaving N orphaned `in_run` sessions while the run
 * itself is "cancelled".
 *
 * What we lock in here:
 *   1. cancel completes successfully when the actor has run.create
 *      but NOT run.eject_session.
 *   2. After cancel, run.status === 'cancelled'.
 *   3. After cancel, every attached session.status === 'approved'
 *      (NOT 'in_run' — the perm-synthesis worked).
 *   4. The cancel response reports `ejectedSessions === N` and
 *      `ejectionFailures === []`.
 *
 * Skipped when DATABASE_URL is unset OR SKIP_PG_TESTS=1; CI's
 * integration job runs Postgres so this fires there.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb, schema as s } from '@compass/db';
import {
  apply as applyOrder,
  decide as decideOrder,
  emptyState as emptyOrderState,
} from '@compass/domain/order';
import { applyRun, decideRun, emptyRunState } from '@compass/domain/run';
import { appendEvents, projectOrder, readStream } from '@compass/streams';
import { projectRun } from '../services/runProjection';
import type { OrderEvent } from '@compass/domain/order';
import { appRouter } from '../trpc/router';
import type { RequestContext, SessionContext } from '../trpc/context';
import { SHOULD_RUN } from './helpers/pg';
import { freshTgId } from './helpers/telegram';
import { testContext } from './helpers/ctx';
import { orderStream, runStream } from './helpers/streams';
import { cleanUpAfterAll, noteOrg, noteUser } from './helpers/cleanup';

cleanUpAfterAll();

/**
 * Direct tRPC callers can issue the next request in the same JavaScript turn.
 * Yield once so postgres-js can recycle the completed test transaction,
 * matching the natural boundary between HTTP requests.
 */
function settleDirectCallerTransaction(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Fixture {
  orgId: string;
  storeId: string;
  skuId: string;
  staffMemberId: string;
  staffUserId: string;
  /** Has run.create but NOT run.eject_session — the M1.7 case. */
  cancellerCtx: RequestContext;
  confirmerCtx: RequestContext;
  cancellerUserId: string;
  cancellerMemberId: string;
  slug: string;
}

let fix: Fixture | null = null;

(SHOULD_RUN ? beforeAll : beforeAll.bind(null))(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const slug = `cancel-${Date.now()}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug, name: 'Cancel-cascade test', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  noteOrg(org!.id);
  const [staffUser] = await db
    .insert(s.users)
    .values({ displayName: 'Staff', tgUserId: freshTgId() })
    .returning();
  noteUser(staffUser!.id);
  const [cancellerUser] = await db
    .insert(s.users)
    .values({ displayName: 'Canceller', tgUserId: freshTgId() })
    .returning();
  noteUser(cancellerUser!.id);
  const [staffMember] = await db
    .insert(s.members)
    .values({ orgId: org!.id, userId: staffUser!.id })
    .returning();
  const [cancellerMember] = await db
    .insert(s.members)
    .values({ orgId: org!.id, userId: cancellerUser!.id })
    .returning();
  const [store] = await db
    .insert(s.stores)
    .values({ orgId: org!.id, name: 'Test Store', code: 'CC-' + slug.slice(-6) })
    .returning();
  // P0 H1 (2026-07-03): run mutations now enforce the same store-scope
  // gate run.create/run.get already apply — a store-tier actor
  // (run.create without run.create.org) must be bound to a store the run
  // touches. Bind the canceller to the run's store so this fixture models
  // a real purchaser rather than a state run.create itself would reject.
  await db.insert(s.memberStoreAssignments).values([
    { memberId: cancellerMember!.id, storeId: store!.id, assignedBy: cancellerUser!.id },
    { memberId: staffMember!.id, storeId: store!.id, assignedBy: cancellerUser!.id },
  ]);
  // Permission-specific scope is resolved from persisted bindings rather
  // than the flat SessionContext union. Give the canceller run.create in the
  // concrete store while deliberately withholding run.eject_session.
  await db
    .insert(s.permissions)
    .values({ key: 'run.create', description: 'Create or cancel a store run' })
    .onConflictDoNothing();
  const [cancellerRole] = await db
    .insert(s.roles)
    .values({
      orgId: org!.id,
      slug: `canceller-${slug}`,
      name: 'Run canceller',
      rank: 40,
    })
    .returning();
  await db.insert(s.rolePermissions).values({
    roleId: cancellerRole!.id,
    permissionKey: 'run.create',
  });
  await db.insert(s.memberRoleBindings).values({
    memberId: cancellerMember!.id,
    roleId: cancellerRole!.id,
    scopeType: 'store',
    scopeId: store!.id,
  });
  const [sku] = await db
    .insert(s.skus)
    .values({
      orgId: org!.id,
      code: 'BEEF-' + slug.slice(-6),
      names: { en: 'Beef' },
      unit: 'kg',
      step: '0.5',
    })
    .returning();

  // Canceller carries run.create (cancel gate) but NOT run.eject_session.
  // That's the whole point — the M1.7-fix ensures the cascade still
  // ejects sessions despite the missing perm.
  const cancellerSession: SessionContext = {
    userId: cancellerUser!.id,
    memberId: cancellerMember!.id,
    orgId: org!.id,
    orgTimezone: 'UTC',
    permissions: new Set(['run.create']),
    roleSlugs: new Set(['canceller']),
  };
  await db
    .insert(s.permissions)
    .values({ key: 'delivery.confirm', description: 'Confirm a store delivery' })
    .onConflictDoNothing();
  const [confirmerRole] = await db
    .insert(s.roles)
    .values({
      orgId: org!.id,
      slug: `confirmer-${slug}`,
      name: 'Delivery confirmer',
      rank: 20,
    })
    .returning();
  await db.insert(s.rolePermissions).values({
    roleId: confirmerRole!.id,
    permissionKey: 'delivery.confirm',
  });
  await db.insert(s.memberRoleBindings).values({
    memberId: staffMember!.id,
    roleId: confirmerRole!.id,
    scopeType: 'store',
    scopeId: store!.id,
  });
  const confirmerSession: SessionContext = {
    userId: staffUser!.id,
    memberId: staffMember!.id,
    orgId: org!.id,
    orgTimezone: 'UTC',
    permissions: new Set(['delivery.confirm']),
    roleSlugs: new Set([confirmerRole!.slug]),
  };

  fix = {
    orgId: org!.id,
    storeId: store!.id,
    skuId: sku!.id,
    staffMemberId: staffMember!.id,
    staffUserId: staffUser!.id,
    cancellerCtx: testContext(cancellerSession),
    confirmerCtx: testContext(confirmerSession),
    cancellerUserId: cancellerUser!.id,
    cancellerMemberId: cancellerMember!.id,
    slug,
  };
});

describe.skipIf(!SHOULD_RUN)('cancel-run cascade (PG-gated)', () => {
  test('cancel ejects all attached sessions even when actor lacks run.eject_session', async () => {
    if (!fix) throw new Error('fixture missing');
    const db = getDb(undefined, { system: 'maintenance' });
    const allPerms = new Set([
      'order.draft',
      'order.submit',
      'order.approve',
      'order.claim',
      'run.create',
      'run.purchase',
    ]);

    // ---- 1. Create + submit + approve TWO sessions ----
    const sessionIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const sessionId = randomUUID();
      sessionIds.push(sessionId);
      const orderLog = orderStream(fix.orgId, sessionId);
      const staffActor = {
        userId: fix.staffUserId,
        memberId: fix.staffMemberId,
        permissions: allPerms,
        isClaimer: false,
      };
      await orderLog.exec({
        type: 'StartDraft',
        orgId: fix.orgId,
        storeId: fix.storeId,
        orderDate: '2026-05-02',
        actor: staffActor,
      });

      await orderLog.exec({
        type: 'AdjustItem',
        skuId: fix.skuId,
        qty: '5',
        sku: { id: fix.skuId, step: '0.5', unit: 'kg', isArchived: false },
        actor: staffActor,
      });

      await orderLog.exec({ type: 'Submit', actor: staffActor });

      await orderLog.exec({
        type: 'Approve',
        actor: { ...staffActor, isClaimer: true },
      });
    }

    // ---- 2. Plan a run + attach both sessions ----
    const runId = randomUUID();
    const runLog = runStream(fix.orgId, runId);
    const purchaserActor = {
      userId: fix.cancellerUserId,
      memberId: fix.cancellerMemberId,
      permissions: allPerms,
    };
    await runLog.exec({
      type: 'PlanRun',
      orgId: fix.orgId,
      runDate: '2026-05-02',
      today: '2026-05-02',
      runIndex: 0,
      sessionIds,
      plannedItems: [{ skuId: fix.skuId, qty: '10' }],
      actor: purchaserActor,
    });

    // Cascade AttachedToRun onto each session — the run.create router
    // does this for real; we mirror it directly here.
    const allPermsWithEject = new Set([...allPerms, 'run.eject_session']);
    for (const sessionId of sessionIds) {
      const persisted = (await readStream(db, 'order', sessionId)) as unknown as OrderEvent[];
      let oState = emptyOrderState(sessionId);
      for (const ev of persisted) oState = applyOrder(oState, ev);
      const attach = decideOrder(oState, {
        type: 'AttachToRun',
        runId,
        actor: {
          userId: fix.cancellerUserId,
          memberId: fix.cancellerMemberId,
          permissions: allPermsWithEject,
          isClaimer: false,
        },
      });
      await appendEvents(db, {
        streamType: 'order',
        streamId: sessionId,
        orgId: fix.orgId,
        events: attach.map((e) => ({ ...e })),
      });
      await projectOrder(db, fix.orgId, attach);
    }

    // Sanity: both sessions are in_run.
    for (const sessionId of sessionIds) {
      const row = await db.query.orderSessionsV.findFirst({
        where: eq(s.orderSessionsV.id, sessionId),
      });
      expect(row?.status).toBe('in_run');
      expect(row?.runId).toBe(runId);
    }

    // ---- 3. The fixture canceller has run.create but NOT run.eject_session.
    //         Call run.cancel via the tRPC caller — this is the path that
    //         must synthesize the eject perm internally.
    const caller = appRouter.createCaller(fix.cancellerCtx);
    const result = await caller.run.cancel({
      runId,
      reason: 'cancel-cascade test',
    });

    expect(result.ejectedSessions).toBe(2);
    expect(result.ejectionFailures).toEqual([]);

    // ---- 4. Run is cancelled. ----
    const runRow = await db.query.marketRunsV.findFirst({
      where: eq(s.marketRunsV.id, runId),
    });
    expect(runRow?.status).toBe('cancelled');

    // ---- 5. Both sessions are back to 'approved' (NOT 'in_run'). ----
    for (const sessionId of sessionIds) {
      const row = await db.query.orderSessionsV.findFirst({
        where: eq(s.orderSessionsV.id, sessionId),
      });
      expect(row?.status).toBe('approved');
      expect(row?.runId).toBeNull();
    }
  });

  test('a delivered run cannot be cancelled (DLV-6): recall the delivery first', async () => {
    if (!fix) throw new Error('fixture missing');
    const db = getDb(undefined, { system: 'maintenance' });
    const runId = randomUUID();
    const sessionId = randomUUID();
    const actor = {
      userId: fix.cancellerUserId,
      memberId: fix.cancellerMemberId,
      permissions: new Set(['run.create', 'run.purchase', 'delivery.dispatch', 'run.finish']),
    };
    let state = emptyRunState(runId);
    const emitted: ReturnType<typeof decideRun> = [];
    const applyCommand = (command: Parameters<typeof decideRun>[1]) => {
      const events = decideRun(state, command);
      emitted.push(...events);
      for (const event of events) state = applyRun(state, event);
    };

    applyCommand({
      type: 'PlanRun',
      orgId: fix.orgId,
      runDate: '2026-05-03',
      today: '2026-05-03',
      runIndex: 0,
      sessionIds: [sessionId],
      plannedItems: [{ skuId: fix.skuId, qty: '1' }],
      actor,
    });
    applyCommand({ type: 'StartPurchase', actor });
    applyCommand({
      type: 'PurchaseItem',
      skuId: fix.skuId,
      supplierId: null,
      unitPrice: '100',
      actualQty: '1',
      receiptPhotoUrl: null,
      storeSplits: [{ storeId: fix.storeId, qty: '1' }],
      paymentMethod: 'cash',
      actor,
    });
    applyCommand({ type: 'StartDelivery', actor });
    applyCommand({ type: 'DeliverToStore', storeId: fix.storeId, actor });

    await appendEvents(db, {
      streamType: 'run',
      streamId: runId,
      orgId: fix.orgId,
      events: emitted.map((event) => ({ ...event })),
    });
    await projectRun(db, fix.orgId, emitted);
    await db.insert(s.orderSessionsV).values({
      id: sessionId,
      orgId: fix.orgId,
      storeId: fix.storeId,
      initiatedByMemberId: fix.staffMemberId,
      orderDate: '2026-05-03',
      status: 'archived',
      runId,
    });

    // DLV-6 (2026-10-30): the goods are at the store; cancelling would
    // keep them out of its stock and hand its order back to be bought again.
    await expect(
      appRouter.createCaller(fix.cancellerCtx).run.cancel({
        runId,
        reason: 'cancel after dispatch',
      }),
    ).rejects.toThrow('run.errors.cannotCancelAfterDelivery');
    await settleDirectCallerTransaction();

    const persisted = await readStream(db, 'run', runId);
    expect(persisted.some((event) => event.type === 'RunCancelled')).toBe(false);
  });
});
