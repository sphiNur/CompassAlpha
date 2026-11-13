/**
 * Medium findings of the 2026-10-30 operation atlas, server side:
 *   ORD-5  withdrawing a batch while a draft is open answered "edited by
 *          someone else" (the one-draft-per-day index);
 *   ORD-9  a 1,000,000,000 quantity overflowed numeric(12,3) as a 500;
 *   ADM-6  a suspended admin could not be removed or lose the admin role
 *          while one other admin remained;
 *   ADM-7  two grants of one role at once made two bindings.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/medium-guards.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { getDb, schema as s, withOrgContext } from '@compass/db';
import { nextDate, todayInTz } from '@compass/domain';
import { appRouter } from '../trpc/router';
import { countAdminsInOrg } from '../services/adminAuthority';
import { and, eq, like } from 'drizzle-orm';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor, openConnections } from './helpers/ctx';
import { seedOwnedOrg, seedRoles, seedMember, sessionOf } from './helpers/fixtures';
import { errorOf } from './helpers/errors';
import { cleanUpAfterAll, noteOrg } from './helpers/cleanup';
import { middayZone } from './helpers/zone';

cleanUpAfterAll();

/** The order calls send no date, so the server takes the org's today;
 *  where it is midday that does not change while the file runs, and
 *  "tomorrow" below is the server's tomorrow too (review TEST1-09). */
const TZ = middayZone(new Date());

type Caller = ReturnType<typeof appRouter.createCaller>;
interface Fixture {
  db: ReturnType<typeof getDb>;
  orgId: string;
  storeId: string;
  skuId: string;
  owner: Caller;
  staff: Caller;
  staffUserId: string;
  staffMemberId: string;
  admins: Array<{ userId: string; memberId: string; bindingId: string }>;
}
let fix: Fixture | null = null;

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug: `medium-${suffix}`, name: 'Medium guards', localeDefault: 'en', timezone: TZ })
    .returning();
  noteOrg(org!.id);
  const orgId = org!.id;
  const roleIds = await seedRoles(db, orgId, ['super_admin', 'admin', 'staff', 'purchaser']);
  const [store] = await db.insert(s.stores).values({ orgId, name: 'Store', code: `M-${suffix.slice(-6)}` }).returning();
  const [sku] = await db
    .insert(s.skus)
    .values({ orgId, code: `MG-${suffix.slice(-8)}`, names: { en: 'Rice' }, unit: 'kg', step: '1' })
    .returning();

  let n = 0;
  const member = async (slug: string, scope: 'global' | 'store') => {
    n += 1;
    const who = await seedMember(db, orgId, {
      name: `Medium ${n}`,
      stores: [store!.id],
      roles: [{ roleId: roleIds[slug]!, storeId: scope === 'store' ? store!.id : null }],
    });
    const caller = callerFor(await sessionOf(orgId, who));
    return { caller, userId: who.userId, memberId: who.memberId, bindingId: who.bindingIds[0]! };
  };
  const owner = await member('super_admin', 'global');
  const staff = await member('staff', 'store');
  const a1 = await member('admin', 'global');
  const a2 = await member('admin', 'global');
  fix = {
    db,
    orgId,
    storeId: store!.id,
    skuId: sku!.id,
    owner: owner.caller,
    staff: staff.caller,
    staffUserId: staff.userId,
    staffMemberId: staff.memberId,
    admins: [a1, a2],
  };
});

describe.skipIf(!SHOULD_RUN)('medium guards (PG-gated)', () => {
  test('ORD-5: withdrawing a batch while a draft is open says to deal with the draft', async () => {
    const { staff, storeId, skuId } = fix!;
    const first = await staff.order.adjustItem({ storeId, skuId, qty: '2' });
    await staff.order.submit({ sessionId: first.sessionId });
    const second = await staff.order.adjustItem({ storeId, skuId, qty: '1' });
    expect(second.sessionId).not.toBe(first.sessionId);
    const err = await errorOf(() => staff.order.withdraw({ sessionId: first.sessionId }));
    expect(err?.code).toBe('PRECONDITION_FAILED');
    expect(err?.message).toBe('order.errors.withdrawDraftOpen');
  });

  test('ORD-9: an absurd quantity is refused as input, not a 500', async () => {
    const { staff, storeId, skuId } = fix!;
    const err = await errorOf(() => staff.order.adjustItem({ storeId, skuId, qty: '1000000000' }));
    expect(err?.code).toBe('BAD_REQUEST');
  });

  test('ORD-11: a phone whose clock runs ahead cannot open a draft for tomorrow', async () => {
    const { staff, storeId, skuId } = fix!;
    const tomorrow = nextDate(todayInTz(TZ));
    const err = await errorOf(() => staff.order.adjustItem({ storeId, skuId, qty: '1', date: tomorrow }));
    expect(err?.code).toBe('PRECONDITION_FAILED');
    expect(err?.message).toBe('order.errors.deviceDateAhead');
  });

  test('APR-6: approving one\'s own order tells the store\'s other approvers', async () => {
    const { db, orgId, storeId, skuId } = fix!;
    // The owner (super_admin, global) orders and approves it themselves.
    const owner = fix!.owner;
    const draft = await owner.order.adjustItem({ storeId, skuId, qty: '3' });
    await owner.order.submit({ sessionId: draft.sessionId });
    await owner.order.claim({ sessionId: draft.sessionId });
    await owner.order.approve({ sessionId: draft.sessionId });
    const told = await db
      .select({ to: s.notifications.recipientUserId })
      .from(s.notifications)
      .where(
        and(
          eq(s.notifications.orgId, orgId),
          eq(s.notifications.template, 'order.selfApproved'),
          like(s.notifications.dedupKey, `order:${draft.sessionId}:selfApproved:%`),
        ),
      );
    // The other approvers here are the two admins; the owner, who approved
    // it, is not told.
    expect([...new Set(told.map((r) => r.to))].sort()).toEqual(
      fix!.admins.map((a) => a.userId).sort(),
    );
  });

  test('ADM-21: unknown keys and past expiries are refused; revoking nothing writes no audit', async () => {
    const { owner, staffMemberId, db, orgId } = fix!;
    const unknown = await errorOf(() =>
      owner.admin.memberPermissionSet({ memberId: staffMemberId, permissionKey: 'no.such.key', effect: 'allow' }),
    );
    expect(unknown?.message).toBe('admin.errors.unknownPermission');
    const past = await errorOf(() =>
      owner.admin.memberPermissionSet({
        memberId: staffMemberId,
        permissionKey: 'order.draft',
        effect: 'deny',
        expiresAt: '2020-01-01T00:00:00.000Z',
      }),
    );
    expect(past?.message).toBe('admin.errors.invalidExpiresAt');
    const before = await db.query.policyDecisions.findMany({ where: (x, o) => o.eq(x.orgId, orgId) });
    await owner.admin.memberPermissionRevoke({ memberId: staffMemberId, permissionKey: 'order.draft' });
    const after = await db.query.policyDecisions.findMany({ where: (x, o) => o.eq(x.orgId, orgId) });
    expect(after.length).toBe(before.length);
  });

  test('ADM-7: five grants of one role at once leave one binding', async () => {
    const { owner, orgId, staffUserId, staffMemberId, storeId, db } = fix!;
    // Without open connections the grants would run one after another.
    await openConnections(orgId, 5);
    const replies = await Promise.all(
      Array.from({ length: 5 }, () =>
        owner.admin.grantRole({ userId: staffUserId, roleSlug: 'purchaser', scopeType: 'store', scopeId: storeId }),
      ),
    );
    const rows = await db
      .select({ id: s.memberRoleBindings.id })
      .from(s.memberRoleBindings)
      .innerJoin(s.roles, eq(s.roles.id, s.memberRoleBindings.roleId))
      .where(and(eq(s.memberRoleBindings.memberId, staffMemberId), eq(s.roles.slug, 'purchaser')));
    expect(rows).toHaveLength(1);
    // One grant made the binding; the other four were pointed at it.
    expect(replies.filter((r) => r.granted)).toHaveLength(1);
    expect([...new Set(replies.map((r) => r.bindingId))]).toEqual([rows[0]!.id]);
  });

  test('ADM-6: a suspended admin can lose the admin role and be removed', async () => {
    // An organisation of the test's own, where the owner is the one other
    // active admin-rank member. The test used to suspend the shared admins,
    // and run before APR-6 it left APR-6 nobody to tell (review NEW-RAND-01).
    const db = fix!.db;
    const org = await seedOwnedOrg(db, 'ADM-6 suspended admins');
    const owner = callerFor(org.session);
    const suspendedAdmin = (name: string) =>
      seedMember(db, org.orgId, {
        name,
        status: 'suspended',
        roles: [{ roleId: org.roleIds.admin! }],
      });
    const a1 = await suspendedAdmin('Suspended admin 1');
    const a2 = await suspendedAdmin('Suspended admin 2');
    expect(
      await errorOf(() => owner.admin.revokeRole({ bindingId: a1.bindingIds[0]! })),
    ).toBeNull();
    expect(await errorOf(() => owner.admin.memberRemove({ memberId: a2.memberId }))).toBeNull();
  });

  test('ADM-6: with the last active admin taken away, none is left to count', async () => {
    // The API does not reach this today: whoever removes, suspends or
    // demotes an admin must outrank them org-wide, and so is an active
    // admin who still counts. The count is checked here so that the guard
    // still refuses if those gates ever change.
    const db = fix!.db;
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const [org] = await db
      .insert(s.organizations)
      .values({
        slug: `last-admin-${suffix}`,
        name: 'Last admin',
        localeDefault: 'en',
        timezone: 'UTC',
      })
      .returning();
    noteOrg(org!.id);
    const orgId = org!.id;
    const roles = await seedRoles(db, orgId, ['super_admin', 'admin']);
    const owner = await seedMember(db, orgId, {
      name: 'Owner',
      roles: [{ roleId: roles.super_admin! }],
    });
    const twice = await seedMember(db, orgId, {
      name: 'Admin twice',
      roles: [{ roleId: roles.admin! }, { roleId: roles.super_admin! }],
    });
    const away = await seedMember(db, orgId, {
      name: 'Suspended admin',
      status: 'suspended',
      roles: [{ roleId: roles.admin! }],
    });
    const left = (except?: { memberId?: string; bindingId?: string }) =>
      withOrgContext(getDb(), orgId, (tx) => countAdminsInOrg(tx, orgId, except));

    // The suspended admin is not counted, so taking them away leaves two.
    expect(await left()).toBe(2);
    expect(await left({ memberId: away.memberId })).toBe(2);
    // One of two admin roles: the member stays an admin.
    expect(await left({ bindingId: twice.bindingIds[0] })).toBe(2);
    expect(await left({ memberId: owner.memberId })).toBe(1);
    // With the other one suspended, the owner is the last admin.
    await db.update(s.members).set({ status: 'suspended' }).where(eq(s.members.id, twice.memberId));
    expect(await left({ memberId: owner.memberId })).toBe(0);
    expect(await left({ bindingId: owner.bindingIds[0] })).toBe(0);
  });
});
