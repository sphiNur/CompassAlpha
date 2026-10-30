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
 *   CA-27  setSessionExtras by {storeId, date} lazily creates the draft, so
 *          an extras-only order can be saved and submitted.
 *   CA-25  A self-edit carrying a past date with no open draft/rejected
 *          batch is refused (order.errors.staleOfflineEdit).
 *   CA-43  approve/reject with an `expectedSeq` the staff has since moved
 *          past → CONFLICT; the approver's own claim doesn't count.
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

/** The date under test: today in the org's zone (UTC). A past date may not
 *  lazy-create a draft (CA-25) and since ORD-11 (2026-10-30) neither may a
 *  future one, so each scenario gets its own store instead of its own day. */
const ORDER_DATE = new Date().toISOString().slice(0, 10);
const EXTRAS_DATE = ORDER_DATE;
const SEQ_DATE = ORDER_DATE;

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
  extrasStoreId: string;
  seqStoreId: string;
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
  const [store, extrasStore, seqStore] = await db
    .insert(s.stores)
    .values(
      ['OV', 'OE', 'OS'].map((prefix, i) => ({
        orgId: org!.id,
        name: `Visibility Store ${i + 1}`,
        code: `${prefix}-` + slug.slice(-6),
      })),
    )
    .returning();
  const stores = [store!, extrasStore!, seqStore!];
  await db.insert(s.memberStoreAssignments).values(
    stores.flatMap((st) => [
      { memberId: staffMember!.id, storeId: st.id, assignedBy: staffUser!.id },
      { memberId: mgrMember!.id, storeId: st.id, assignedBy: mgrUser!.id },
    ]),
  );
  // The order router resolves per-store permissions from persisted role
  // bindings, not the flat SessionContext set — bind both members.
  const staffPerms = ['order.draft', 'order.submit'];
  const mgrPerms = ['order.draft', 'order.submit', 'order.claim', 'order.approve'];
  await db
    .insert(s.permissions)
    .values(mgrPerms.map((key) => ({ key, description: key })))
    .onConflictDoNothing();
  const [staffRole] = await db
    .insert(s.roles)
    .values({ orgId: org!.id, slug: `staff-${slug}`, name: 'Staff', rank: 20 })
    .returning();
  const [mgrRole] = await db
    .insert(s.roles)
    .values({ orgId: org!.id, slug: `manager-${slug}`, name: 'Manager', rank: 60 })
    .returning();
  await db
    .insert(s.rolePermissions)
    .values([
      ...staffPerms.map((permissionKey) => ({ roleId: staffRole!.id, permissionKey })),
      ...mgrPerms.map((permissionKey) => ({ roleId: mgrRole!.id, permissionKey })),
    ]);
  await db.insert(s.memberRoleBindings).values(
    stores.flatMap((st) => [
      { memberId: staffMember!.id, roleId: staffRole!.id, scopeType: 'store', scopeId: st.id },
      { memberId: mgrMember!.id, roleId: mgrRole!.id, scopeType: 'store', scopeId: st.id },
    ]),
  );
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
    extrasStoreId: extrasStore!.id,
    seqStoreId: seqStore!.id,
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

describe.skipIf(!SHOULD_RUN)('order follow-ups CA-25 / CA-27 / CA-43 (PG-gated)', () => {
  const extra = { name: 'Paper towels', qty: '2', unit: 'pack' as const };

  test('CA-27: extras-only order via storeId lazy-creates the draft and submits', async () => {
    if (!fix) throw new Error('fixture missing');
    const staff = appRouter.createCaller(fix.staff);
    const input = { storeId: fix.extrasStoreId, date: EXTRAS_DATE };

    // Clearing extras with no session is a no-op — no empty draft.
    const none = await staff.order.setSessionExtras({ ...input, extras: [] });
    expect(none.sessionId).toBeNull();
    expect(await staff.order.todaySession(input)).toBeNull();

    const saved = await staff.order.setSessionExtras({ ...input, extras: [extra] });
    expect(saved.sessionId).toBeTruthy();
    const sessionId = saved.sessionId!;
    const draft = await staff.order.todaySession(input);
    expect(draft?.id).toBe(sessionId);
    expect(draft?.status).toBe('draft');
    expect(draft?.extras).toHaveLength(1);

    // Second save by storeId lands on the SAME draft; a later SKU tap too.
    const again = await staff.order.setSessionExtras({
      ...input,
      extras: [extra, { ...extra, name: 'Gloves' }],
    });
    expect(again.sessionId).toBe(sessionId);
    const tap = await staff.order.adjustItem({ ...input, skuId: fix.skuId, qty: '0.5' });
    expect(tap.sessionId).toBe(sessionId);
    await staff.order.adjustItem({ ...input, skuId: fix.skuId, qty: '0' });

    await staff.order.submit({ sessionId });
    expect((await staff.order.todaySession(input))?.status).toBe('submitted');

    // APR-18: an expectedSeq from an older read is refused, not ignored.
    await expect(
      staff.order.markExtraStatus({ sessionId, extraIndex: 0, status: 'bought', expectedSeq: 1 }),
    ).rejects.toMatchObject({ message: 'order.errors.staleSeq' });
  });

  test('CA-25: a past-dated self-edit with no open draft is refused, not lazily created', async () => {
    if (!fix) throw new Error('fixture missing');
    const staff = appRouter.createCaller(fix.staff);
    const past = { storeId: fix.storeId, date: '2000-01-03' };
    await expect(
      staff.order.adjustItem({ ...past, skuId: fix.skuId, qty: '1' }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'order.errors.staleOfflineEdit',
    });
    await expect(staff.order.setSessionExtras({ ...past, extras: [extra] })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'order.errors.staleOfflineEdit',
    });
    expect(await staff.order.todaySession(past)).toBeNull();
  });

  test('CA-43: approve/reject refuse an order that changed since the approver looked', async () => {
    if (!fix) throw new Error('fixture missing');
    const staff = appRouter.createCaller(fix.staff);
    const mgr = appRouter.createCaller(fix.manager);
    const input = { storeId: fix.seqStoreId, date: SEQ_DATE };

    const first = await staff.order.adjustItem({ ...input, skuId: fix.skuId, qty: '1' });
    const sessionId = first.sessionId;
    await staff.order.submit({ sessionId });
    const seenRow = (await mgr.order.pendingList(input)).find((r) => r.id === sessionId);
    expect(typeof seenRow?.lastSeq).toBe('number');
    const seen = seenRow!.lastSeq;

    // Staff pulls it back, changes the quantity and re-submits.
    await staff.order.withdraw({ sessionId });
    await staff.order.adjustItem({ ...input, skuId: fix.skuId, qty: '5' });
    await staff.order.submit({ sessionId });

    await expect(mgr.order.approve({ sessionId, expectedSeq: seen })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'order.errors.staleSeq',
    });
    await expect(
      mgr.order.reject({ sessionId, reason: 'no', expectedSeq: seen }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // Fresh look → the approver's own claim after it does not count.
    const fresh = (await mgr.order.pendingList(input)).find((r) => r.id === sessionId)!.lastSeq;
    await mgr.order.claim({ sessionId });
    await expect(mgr.order.approve({ sessionId, expectedSeq: fresh })).resolves.toBeDefined();
    // CA-26 retry with the same (now behind) seq stays a no-op success.
    await expect(mgr.order.approve({ sessionId, expectedSeq: fresh })).resolves.toBeDefined();
  });
});
