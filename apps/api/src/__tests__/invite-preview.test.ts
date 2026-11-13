/**
 * UX-24 (2026-11-14): admin.memberInvitePreview says whether an invite by
 * Telegram ID would reach someone already in the workspace, so the form
 * asks before adding a role to them. It is gated, planned and refused as
 * memberInviteByTgId is, writes nothing, and names the person only to an
 * inviter whose member list shows them.
 *
 * Skipped when DATABASE_URL is unset or SKIP_PG_TESTS=1.
 */
import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import { appRouter } from '../trpc/router';
import { SHOULD_RUN } from './helpers/pg';
import { freshTgId } from './helpers/telegram';
import { testContext } from './helpers/ctx';
import { errorOf } from './helpers/errors';
import { scopeOrgSuite } from './helpers/scopeOrg';

const { fixture, makeStore, makeUser, makeMember, bindRole, sessionFor } =
  scopeOrgSuite('Invite Preview Tests');

const db = () => getDb(undefined, { system: 'maintenance' });

/** A manager of `storeId` only, as a caller. */
async function managerOf(storeId: string) {
  const user = await makeUser(`Manager ${Math.random()}`);
  const memberId = await makeMember(user.id);
  await bindRole(memberId, fixture().managerRoleId, { type: 'store', storeId });
  return appRouter.createCaller(testContext(await sessionFor(memberId, user.id)));
}

/** A member of the org with `name`, assigned to `storeId` when given. */
async function existingMember(name: string, storeId?: string) {
  const user = await makeUser(name);
  const memberId = await makeMember(user.id);
  if (storeId) await db().insert(s.memberStoreAssignments).values({ memberId, storeId });
  return { userId: user.id, memberId, tgUserId: user.tgUserId.toString() };
}

async function storesOf(memberId: string): Promise<string[]> {
  const rows = await db()
    .select({ storeId: s.memberStoreAssignments.storeId })
    .from(s.memberStoreAssignments)
    .where(eq(s.memberStoreAssignments.memberId, memberId));
  return rows.map((r) => r.storeId).sort();
}

async function bindingCount(memberId: string): Promise<number> {
  const rows = await db()
    .select({ id: s.memberRoleBindings.id })
    .from(s.memberRoleBindings)
    .where(eq(s.memberRoleBindings.memberId, memberId));
  return rows.length;
}

describe('admin.memberInvitePreview', () => {
  test.skipIf(!SHOULD_RUN)('a new Telegram ID: not a member, and no one is created', async () => {
    const owner = appRouter.createCaller(fixture().superAdminCtx);
    const store = await makeStore(`P-new-${Math.random()}`);
    const tgUserId = freshTgId();
    expect(
      await owner.admin.memberInvitePreview({
        tgUserId: tgUserId.toString(),
        roleSlug: 'staff',
        storeIds: [store.id],
      }),
    ).toEqual({ existing: false, displayName: null });
    const users = await db()
      .select({ id: s.users.id })
      .from(s.users)
      .where(eq(s.users.tgUserId, tgUserId));
    expect(users).toEqual([]);
  });

  test.skipIf(!SHOULD_RUN)(
    'an existing member: named to the owner, and nothing is added',
    async () => {
      const owner = appRouter.createCaller(fixture().superAdminCtx);
      const storeA = await makeStore(`P-A-${Math.random()}`);
      const storeB = await makeStore(`P-B-${Math.random()}`);
      const leo = await existingMember('Leo Park', storeA.id);
      const before = await bindingCount(leo.memberId);
      expect(
        await owner.admin.memberInvitePreview({
          tgUserId: leo.tgUserId,
          roleSlug: 'staff',
          storeIds: [storeB.id],
        }),
      ).toEqual({ existing: true, displayName: 'Leo Park' });
      expect(await storesOf(leo.memberId)).toEqual([storeA.id]);
      expect(await bindingCount(leo.memberId)).toBe(before);
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'a store manager: refused for a store they do not run, as the invite is',
    async () => {
      const storeA = await makeStore(`P-A-${Math.random()}`);
      const storeB = await makeStore(`P-B-${Math.random()}`);
      const manager = await managerOf(storeA.id);
      const request = { tgUserId: String(freshTgId()), storeIds: [storeB.id] };
      const viaPreview = await errorOf(() => manager.admin.memberInvitePreview(request));
      const viaInvite = await errorOf(() => manager.admin.memberInviteByTgId(request));
      expect(viaPreview?.message).toContain('notAdminOfStore');
      expect([viaPreview?.code, viaPreview?.message]).toEqual([
        viaInvite?.code,
        viaInvite?.message,
      ]);
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'a store manager: someone outside their member list is not named',
    async () => {
      const storeA = await makeStore(`P-A-${Math.random()}`);
      const storeB = await makeStore(`P-B-${Math.random()}`);
      const manager = await managerOf(storeA.id);
      const elsewhere = await existingMember('Hidden Person', storeB.id);
      const mine = await existingMember('Ella Brook', storeA.id);
      expect(
        await manager.admin.memberInvitePreview({
          tgUserId: elsewhere.tgUserId,
          roleSlug: 'staff',
          storeIds: [storeA.id],
        }),
      ).toEqual({ existing: true, displayName: null });
      expect(
        await manager.admin.memberInvitePreview({
          tgUserId: mine.tgUserId,
          roleSlug: 'staff',
          storeIds: [storeA.id],
        }),
      ).toEqual({ existing: true, displayName: 'Ella Brook' });
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'ADM1-08: a role the existing member may not be given is refused, as the invite is',
    async () => {
      const storeA = await makeStore(`P-A-${Math.random()}`);
      const manager = await managerOf(storeA.id);
      // A fellow manager of A: a manager of A may not change their roles.
      const peer = await existingMember('Peer Manager', storeA.id);
      await bindRole(peer.memberId, fixture().managerRoleId, {
        type: 'store',
        storeId: storeA.id,
      });
      const request = { tgUserId: peer.tgUserId, roleSlug: 'staff', storeIds: [storeA.id] };
      const viaPreview = await errorOf(() => manager.admin.memberInvitePreview(request));
      const viaInvite = await errorOf(() => manager.admin.memberInviteByTgId(request));
      expect(viaPreview?.code).toBe('FORBIDDEN');
      expect([viaPreview?.code, viaPreview?.message]).toEqual([
        viaInvite?.code,
        viaInvite?.message,
      ]);
    },
  );

  test.skipIf(!SHOULD_RUN)('a suspended member: reactivate first, as the invite says', async () => {
    const owner = appRouter.createCaller(fixture().superAdminCtx);
    const store = await makeStore(`P-S-${Math.random()}`);
    const gone = await existingMember('Suspended Person', store.id);
    await db()
      .update(s.members)
      .set({ status: 'suspended' })
      .where(and(eq(s.members.id, gone.memberId), eq(s.members.orgId, fixture().orgId)));
    const err = await errorOf(() =>
      owner.admin.memberInvitePreview({
        tgUserId: gone.tgUserId,
        roleSlug: 'staff',
        storeIds: [store.id],
      }),
    );
    expect(err?.message).toBe('admin.errors.memberInactiveReactivateFirst');
  });
});
