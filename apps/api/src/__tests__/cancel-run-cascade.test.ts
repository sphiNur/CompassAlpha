/**
 * Cancel-run cascade integration test (M1.9, 2026-05-07).
 *
 * The pre-launch readiness audit flagged this as a CRITICAL untested
 * path. Specifically the M1.7-fix at `run.ts:1036` synthesizes the
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
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb, schema as s, withOrgContext } from '@compass/db';
import {
  apply as applyOrder,
  decide as decideOrder,
  emptyState as emptyOrderState,
} from '@compass/domain/order';
import {
  applyRun,
  decideRun,
  emptyRunState,
} from '@compass/domain/run';
import { appendEvents, readStream } from '../services/eventStore';
import { projectOrder } from '../services/orderProjection';
import { projectRun } from '../services/runProjection';
import type { OrderEvent } from '@compass/domain/order';
import { logger } from '../infra/log';
import { appRouter } from '../trpc/router';
import type { RequestContext, SessionContext } from '../trpc/context';

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
    async withOrg(fn) {
      return withOrgContext(db, session.orgId, fn);
    },
  };
}

interface Fixture {
  orgId: string;
  storeId: string;
  skuId: string;
  staffMemberId: string;
  staffUserId: string;
  /** Has run.create but NOT run.eject_session — the M1.7 case. */
  cancellerCtx: RequestContext;
  cancellerUserId: string;
  cancellerMemberId: string;
  slug: string;
}

let fix: Fixture | null = null;

(SHOULD_RUN ? beforeAll : beforeAll.bind(null))(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb();
  const slug = `cancel-${Date.now()}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug, name: 'Cancel-cascade test', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  const [staffUser] = await db
    .insert(s.users)
    .values({ displayName: 'Staff', tgUserId: BigInt(`9${Date.now()}1`.slice(-12)) })
    .returning();
  const [cancellerUser] = await db
    .insert(s.users)
    .values({ displayName: 'Canceller', tgUserId: BigInt(`9${Date.now()}2`.slice(-12)) })
    .returning();
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
    permissions: new Set(['run.create']),
    roleSlugs: new Set(['canceller']),
  };

  fix = {
    orgId: org!.id,
    storeId: store!.id,
    skuId: sku!.id,
    staffMemberId: staffMember!.id,
    staffUserId: staffUser!.id,
    cancellerCtx: buildCtx(db, cancellerSession),
    cancellerUserId: cancellerUser!.id,
    cancellerMemberId: cancellerMember!.id,
    slug,
  };
});

afterAll(() => {
  // Slugs are timestamped — leaving rows simplifies forensic
  // inspection if a future run flakes.
});

describe.skipIf(!SHOULD_RUN)('cancel-run cascade (PG-gated)', () => {
  test('cancel ejects all attached sessions even when actor lacks run.eject_session', async () => {
    if (!fix) throw new Error('fixture missing');
    const db = getDb();
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
      let oState = emptyOrderState(sessionId);
      const staffActor = {
        userId: fix.staffUserId,
        memberId: fix.staffMemberId,
        permissions: allPerms,
        isClaimer: false,
      };
      const start = decideOrder(oState, {
        type: 'StartDraft',
        orgId: fix.orgId,
        storeId: fix.storeId,
        orderDate: '2026-05-02',
        actor: staffActor,
      });
      for (const e of start) oState = applyOrder(oState, e);
      await appendEvents(db, {
        streamType: 'order',
        streamId: sessionId,
        orgId: fix.orgId,
        events: start.map((e) => ({ ...e })),
      });
      await projectOrder(db, fix.orgId, start);

      const adjust = decideOrder(oState, {
        type: 'AdjustItem',
        skuId: fix.skuId,
        qty: '5',
        sku: { id: fix.skuId, step: '0.5', unit: 'kg', isArchived: false },
        actor: staffActor,
      });
      for (const e of adjust) oState = applyOrder(oState, e);
      await appendEvents(db, {
        streamType: 'order',
        streamId: sessionId,
        orgId: fix.orgId,
        events: adjust.map((e) => ({ ...e })),
      });
      await projectOrder(db, fix.orgId, adjust);

      const submit = decideOrder(oState, { type: 'Submit', actor: staffActor });
      for (const e of submit) oState = applyOrder(oState, e);
      await appendEvents(db, {
        streamType: 'order',
        streamId: sessionId,
        orgId: fix.orgId,
        events: submit.map((e) => ({ ...e })),
      });
      await projectOrder(db, fix.orgId, submit);

      const approve = decideOrder(oState, {
        type: 'Approve',
        actor: { ...staffActor, isClaimer: true },
      });
      for (const e of approve) oState = applyOrder(oState, e);
      await appendEvents(db, {
        streamType: 'order',
        streamId: sessionId,
        orgId: fix.orgId,
        events: approve.map((e) => ({ ...e })),
      });
      await projectOrder(db, fix.orgId, approve);
    }

    // ---- 2. Plan a run + attach both sessions ----
    const runId = randomUUID();
    let rState = emptyRunState(runId);
    const purchaserActor = {
      userId: fix.cancellerUserId,
      memberId: fix.cancellerMemberId,
      permissions: allPerms,
    };
    const plan = decideRun(rState, {
      type: 'PlanRun',
      orgId: fix.orgId,
      runDate: '2026-05-02',
      runIndex: 0,
      sessionIds,
      plannedItems: [{ skuId: fix.skuId, qty: '10' }],
      actor: purchaserActor,
    });
    for (const e of plan) rState = applyRun(rState, e);
    await appendEvents(db, {
      streamType: 'run',
      streamId: runId,
      orgId: fix.orgId,
      events: plan.map((e) => ({ ...e })),
    });
    await projectRun(db, fix.orgId, plan);

    // Cascade AttachedToRun onto each session — the run.create router
    // does this for real; we mirror it directly here.
    const allPermsWithEject = new Set([...allPerms, 'run.eject_session']);
    for (const sessionId of sessionIds) {
      const persisted = (await readStream(
        db,
        'order',
        sessionId,
      )) as unknown as OrderEvent[];
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
});
