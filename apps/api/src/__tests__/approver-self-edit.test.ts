/**
 * Approver-edits-own-submission regression test (2026-07-30).
 *
 * THE BUG
 *
 * `order.adjustItem` decided which session row to load with:
 *
 *   const isManagerEdit =
 *     input.targetMemberId !== undefined &&
 *     input.targetMemberId !== ctx.session!.memberId;
 *
 * `targetMemberId` is only ever sent by the approval surface, so the
 * second clause did nothing except misroute the case where the approver IS
 * the submitter — an entirely normal setup: a super_admin, or the owner /
 * single-store manager who drafts their own store's order and then
 * approves it.
 *
 * In that case `isManagerEdit` came out false, the lookup asked for "my
 * DRAFT for this date", missed the submitted session the approver had just
 * claimed, fell through to the lazy-create branch (whose guard carried the
 * same redundant `!== me` clause, so it didn't stop it either) and
 * SILENTLY CREATED A SECOND DRAFT SESSION, writing the edit there.
 *
 * Observable symptoms: HTTP 200, no toast, the number on screen unchanged,
 * the real submitted order untouched — and a phantom draft that then
 * shadowed the approved order on the staff member's own Order page,
 * because `order.todaySession` prefers an open draft.
 *
 * WHAT THIS LOCKS IN
 *
 *   1. The adjustment lands on the CLAIMED SUBMITTED session.
 *   2. Its quantity actually changes.
 *   3. No extra session row is created for that (store, date, member).
 *
 * Skipped when DATABASE_URL is unset OR SKIP_PG_TESTS=1.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb, schema as s, withOrgContext } from '@compass/db';
import {
  apply as applyOrder,
  decide as decideOrder,
  emptyState as emptyOrderState,
} from '@compass/domain/order';
import { appendEvents } from '../services/eventStore';
import { projectOrder } from '../services/orderProjection';
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

/** The date under test. Fixed, so "today" drift can't affect the lookup. */
const ORDER_DATE = '2026-05-11';

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

interface Fixture {
  orgId: string;
  storeId: string;
  skuId: string;
  /** One member who both drafts AND approves — the whole point. */
  memberId: string;
  userId: string;
  ctx: RequestContext;
  sessionId: string;
}

let fix: Fixture | null = null;

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb();
  const slug = `selfedit-${Date.now()}`;

  const [org] = await db
    .insert(s.organizations)
    .values({ slug, name: 'Approver self-edit test', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  const [user] = await db
    .insert(s.users)
    .values({ displayName: 'Owner', tgUserId: BigInt(`9${Date.now()}3`.slice(-12)) })
    .returning();
  const [member] = await db
    .insert(s.members)
    .values({ orgId: org!.id, userId: user!.id })
    .returning();
  const [store] = await db
    .insert(s.stores)
    .values({ orgId: org!.id, name: 'Self-edit Store', code: 'SE-' + slug.slice(-6) })
    .returning();
  await db
    .insert(s.memberStoreAssignments)
    .values({ memberId: member!.id, storeId: store!.id, assignedBy: user!.id });
  // step 0.5 so we also prove the router accepts a legitimate off-integer
  // multiple — the approval screen's own step bug shipped alongside this.
  const [sku] = await db
    .insert(s.skus)
    .values({
      orgId: org!.id,
      code: 'ONION-' + slug.slice(-6),
      names: { en: 'Onion' },
      unit: 'kg',
      step: '0.5',
    })
    .returning();

  // Draft -> submit -> claim, all as the SAME member.
  const perms = new Set(['order.draft', 'order.submit', 'order.approve', 'order.claim']);
  const actor = {
    userId: user!.id,
    memberId: member!.id,
    permissions: perms,
    isClaimer: false,
  };
  const sessionId = randomUUID();
  let state = emptyOrderState(sessionId);

  const push = async (events: ReturnType<typeof decideOrder>) => {
    for (const e of events) state = applyOrder(state, e);
    await appendEvents(db, {
      streamType: 'order',
      streamId: sessionId,
      orgId: org!.id,
      events: events.map((e) => ({ ...e })),
    });
    await projectOrder(db, org!.id, events);
  };

  await push(
    decideOrder(state, {
      type: 'StartDraft',
      orgId: org!.id,
      storeId: store!.id,
      orderDate: ORDER_DATE,
      actor,
    }),
  );
  await push(
    decideOrder(state, {
      type: 'AdjustItem',
      skuId: sku!.id,
      qty: '0.5',
      sku: { id: sku!.id, step: '0.5', unit: 'kg', isArchived: false },
      actor,
    }),
  );
  await push(decideOrder(state, { type: 'Submit', actor }));
  await push(decideOrder(state, { type: 'Claim', actor }));

  fix = {
    orgId: org!.id,
    storeId: store!.id,
    skuId: sku!.id,
    memberId: member!.id,
    userId: user!.id,
    sessionId,
    ctx: buildCtx(db, {
      userId: user!.id,
      memberId: member!.id,
      orgId: org!.id,
      orgTimezone: 'UTC',
      permissions: perms,
      roleSlugs: new Set(['owner']),
    }),
  };
});

describe.skipIf(!SHOULD_RUN)('approver editing their own submission (PG-gated)', () => {
  test('edits the claimed submitted session in place — never lazy-creates a phantom draft', async () => {
    if (!fix) throw new Error('fixture missing');
    const db = getDb();
    const caller = appRouter.createCaller(fix.ctx);

    const sessionsBefore = await db
      .select({ id: s.orderSessionsV.id })
      .from(s.orderSessionsV)
      .where(
        and(
          eq(s.orderSessionsV.orgId, fix.orgId),
          eq(s.orderSessionsV.storeId, fix.storeId),
          eq(s.orderSessionsV.orderDate, ORDER_DATE),
        ),
      );
    expect(sessionsBefore).toHaveLength(1);

    // This is exactly what ApprovalPage's QtyControl fires: targetMemberId
    // set to the contributor (who happens to be the actor), plus the
    // session's own orderDate.
    const res = await caller.order.adjustItem({
      storeId: fix.storeId,
      date: ORDER_DATE,
      skuId: fix.skuId,
      qty: '1.5',
      targetMemberId: fix.memberId,
    });

    // 1. It resolved to the session that already existed, not a new stream.
    expect(res.sessionId).toBe(fix.sessionId);

    // 2. The quantity actually moved on that session.
    const items = await db
      .select({ qty: s.orderItemsV.qty, sessionId: s.orderItemsV.sessionId })
      .from(s.orderItemsV)
      .where(eq(s.orderItemsV.sessionId, fix.sessionId));
    expect(items).toHaveLength(1);
    expect(Number(items[0]!.qty)).toBe(1.5);

    // 3. Still exactly one session for this (store, date) — the phantom
    //    draft is the regression this test exists to catch.
    const sessionsAfter = await db
      .select({ id: s.orderSessionsV.id, status: s.orderSessionsV.status })
      .from(s.orderSessionsV)
      .where(
        and(
          eq(s.orderSessionsV.orgId, fix.orgId),
          eq(s.orderSessionsV.storeId, fix.storeId),
          eq(s.orderSessionsV.orderDate, ORDER_DATE),
        ),
      );
    expect(sessionsAfter).toHaveLength(1);
    expect(sessionsAfter[0]!.status).toBe('submitted');
  });

  test('a manager-edit for a member with NO session for that date fails loudly', async () => {
    if (!fix) throw new Error('fixture missing');
    // Pre-fix, the lazy-create guard also carried the redundant `!== me`
    // clause. A targetMemberId pointing at someone with no session must
    // raise NOT_FOUND rather than conjure a draft on their behalf.
    const caller = appRouter.createCaller(fix.ctx);
    await expect(
      caller.order.adjustItem({
        storeId: fix.storeId,
        date: '2026-05-12', // a date with no session at all
        skuId: fix.skuId,
        qty: '1',
        targetMemberId: fix.memberId,
      }),
    ).rejects.toThrow(/sessionMissing/);
  });
});
