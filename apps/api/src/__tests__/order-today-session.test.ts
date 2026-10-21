/**
 * Order page visibility across claim / reject (2026-10-21 audit CA-01,
 * CA-02, CA-26).
 *
 *   CA-01  `todaySession` dropped a batch the moment a manager claimed it
 *          (`claimed_by IS NULL` filter) — the staff saw an empty catalog
 *          and re-ordered. It must keep returning the claimed batch with
 *          the claimer's name.
 *   CA-02  A rejected batch was never returned and `adjustItem` lazily
 *          created a NEW draft instead of editing it. The owner must see
 *          it, edit it in place (same stream) and re-submit it.
 *   CA-26  A repeated Submit / Approve by the same actor is a no-op
 *          success, not PRECONDITION_FAILED.
 *
 * Skipped when DATABASE_URL is unset OR SKIP_PG_TESTS=1.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, schema as s, withOrgContext } from '@compass/db';
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
const ORDER_DATE = '2026-05-13';

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
  staff: RequestContext;
  manager: RequestContext;
}

let fix: Fixture | null = null;

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const slug = `ordvis-${Date.now()}`;

  const [org] = await db
    .insert(s.organizations)
    .values({ slug, name: 'Order visibility test', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  const [staffUser] = await db
    .insert(s.users)
    .values({ displayName: 'Staff', tgUserId: BigInt(`8${Date.now()}1`.slice(-12)) })
    .returning();
  const [mgrUser] = await db
    .insert(s.users)
    .values({ displayName: 'Manager Mia', tgUserId: BigInt(`8${Date.now()}2`.slice(-12)) })
    .returning();
  const [staffMember] = await db
    .insert(s.members)
    .values({ orgId: org!.id, userId: staffUser!.id })
    .returning();
  const [mgrMember] = await db
    .insert(s.members)
    .values({ orgId: org!.id, userId: mgrUser!.id })
    .returning();
  const [store] = await db
    .insert(s.stores)
    .values({ orgId: org!.id, name: 'Visibility Store', code: 'OV-' + slug.slice(-6) })
    .returning();
  await db.insert(s.memberStoreAssignments).values([
    { memberId: staffMember!.id, storeId: store!.id, assignedBy: staffUser!.id },
    { memberId: mgrMember!.id, storeId: store!.id, assignedBy: mgrUser!.id },
  ]);
  const [sku] = await db
    .insert(s.skus)
    .values({
      orgId: org!.id,
      code: 'TOMATO-' + slug.slice(-6),
      names: { en: 'Tomato' },
      unit: 'kg',
      step: '0.5',
    })
    .returning();

  fix = {
    orgId: org!.id,
    storeId: store!.id,
    skuId: sku!.id,
    staff: buildCtx(db, {
      userId: staffUser!.id,
      memberId: staffMember!.id,
      orgId: org!.id,
      orgTimezone: 'UTC',
      permissions: new Set(['order.draft', 'order.submit']),
      roleSlugs: new Set(['staff']),
    }),
    manager: buildCtx(db, {
      userId: mgrUser!.id,
      memberId: mgrMember!.id,
      orgId: org!.id,
      orgTimezone: 'UTC',
      permissions: new Set(['order.draft', 'order.submit', 'order.claim', 'order.approve']),
      roleSlugs: new Set(['manager']),
    }),
  };
});

describe.skipIf(!SHOULD_RUN)('order visibility across claim / reject (PG-gated)', () => {
  test('claimed batch stays visible; rejected batch is edited in place and re-submitted', async () => {
    if (!fix) throw new Error('fixture missing');
    const db = getDb(undefined, { system: 'maintenance' });
    const staff = appRouter.createCaller(fix.staff);
    const mgr = appRouter.createCaller(fix.manager);
    const input = { storeId: fix.storeId, date: ORDER_DATE };

    const first = await staff.order.adjustItem({ ...input, skuId: fix.skuId, qty: '1' });
    const sessionId = first.sessionId;
    await staff.order.submit({ sessionId });
    // CA-26: double tap / lost-response retry is a no-op success.
    await expect(staff.order.submit({ sessionId })).resolves.toBeDefined();

    // CA-01: claimed → still returned, with the claimer's name.
    await mgr.order.claim({ sessionId });
    const claimed = await staff.order.todaySession(input);
    expect(claimed?.id).toBe(sessionId);
    expect(claimed?.status).toBe('submitted');
    expect(claimed?.claimedByDisplayName).toBe('Manager Mia');

    // CA-02: rejected → returned with its reason.
    await mgr.order.reject({ sessionId, reason: 'too many' });
    const rejected = await staff.order.todaySession(input);
    expect(rejected?.id).toBe(sessionId);
    expect(rejected?.status).toBe('rejected');
    expect(rejected?.rejectReason).toBe('too many');

    // Owner edits the SAME stream — no lazily-created second draft.
    const edit = await staff.order.adjustItem({ ...input, skuId: fix.skuId, qty: '0.5' });
    expect(edit.sessionId).toBe(sessionId);
    const rows = await db
      .select({ id: s.orderSessionsV.id })
      .from(s.orderSessionsV)
      .where(
        and(
          eq(s.orderSessionsV.orgId, fix.orgId),
          eq(s.orderSessionsV.storeId, fix.storeId),
          eq(s.orderSessionsV.orderDate, ORDER_DATE),
        ),
      );
    expect(rows).toHaveLength(1);

    await staff.order.submit({ sessionId });
    const resubmitted = await staff.order.todaySession(input);
    expect(resubmitted?.id).toBe(sessionId);
    expect(resubmitted?.status).toBe('submitted');

    // CA-26: repeated approve by the same decider is a no-op success.
    await mgr.order.claim({ sessionId });
    await mgr.order.approve({ sessionId });
    await expect(mgr.order.approve({ sessionId })).resolves.toBeDefined();
  });
});
