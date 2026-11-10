/**
 * A shared invite link must create the member, store assignment and
 * role binding when the recipient opens it. This is the regression
 * for "I accepted the invite but I am not in the system": the old
 * link only opened the bot and never wrote a membership.
 *
 * Skipped when DATABASE_URL is unset OR SKIP_PG_TESTS=1.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import { env } from '../env';
import type { SessionContext } from '../trpc/context';
import { SHOULD_RUN as SHOULD_RUN_PG } from './helpers/pg';
import { signInitData, freshTgId } from './helpers/telegram';
import { callerFor } from './helpers/ctx';

const SHOULD_RUN = SHOULD_RUN_PG && !!env.TELEGRAM_BOT_TOKEN;

describe.skipIf(!SHOULD_RUN)('invite acceptance (PG-gated)', () => {
  let orgId = '';
  let storeId = '';
  let otherStoreId = '';
  let adminUserId = '';
  let adminMemberId = '';
  let managerUserId = '';
  let managerMemberId = '';
  let managerRoleId = '';
  let staffRoleId = '';
  let adminRoleId = '';

  beforeAll(async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    const suffix = Math.random().toString(36).slice(2, 9);
    const [org] = await db
      .insert(s.organizations)
      .values({
        slug: `invite-test-${suffix}`,
        name: `Invite test ${suffix}`,
        localeDefault: 'en',
        timezone: 'UTC',
      })
      .returning();
    orgId = org!.id;

    await db
      .insert(s.permissions)
      .values({ key: 'users.manage', description: 'manage users' })
      .onConflictDoNothing();
    await db
      .insert(s.permissions)
      .values({ key: 'org.admin', description: 'manage organisation' })
      .onConflictDoNothing();

    const [adminRole] = await db
      .insert(s.roles)
      .values({ orgId, slug: `admin-${suffix}`, name: 'Admin', rank: 80 })
      .returning();
    const [staffRole] = await db
      .insert(s.roles)
      .values({ orgId, slug: `staff-${suffix}`, name: 'Staff', rank: 20 })
      .returning();
    const [managerRole] = await db
      .insert(s.roles)
      .values({ orgId, slug: `manager-${suffix}`, name: 'Manager', rank: 60 })
      .returning();
    staffRoleId = staffRole!.id;
    managerRoleId = managerRole!.id;
    adminRoleId = adminRole!.id;
    await db.insert(s.rolePermissions).values([
      { roleId: adminRole!.id, permissionKey: 'users.manage' },
      { roleId: adminRole!.id, permissionKey: 'org.admin' },
      { roleId: managerRole!.id, permissionKey: 'users.manage' },
    ]);

    const [adminUser] = await db
      .insert(s.users)
      .values({ tgUserId: freshTgId(), displayName: 'Admin', displayNameLocked: true })
      .returning();
    adminUserId = adminUser!.id;
    const [adminMember] = await db
      .insert(s.members)
      .values({ orgId, userId: adminUserId, status: 'active' })
      .returning();
    adminMemberId = adminMember!.id;
    await db.insert(s.memberRoleBindings).values({
      memberId: adminMemberId,
      roleId: adminRole!.id,
      scopeType: 'global',
      scopeId: null,
      grantedBy: adminUserId,
    });

    const [managerUser] = await db
      .insert(s.users)
      .values({
        tgUserId: freshTgId(),
        displayName: 'Manager',
        displayNameLocked: true,
      })
      .returning();
    managerUserId = managerUser!.id;
    const [managerMember] = await db
      .insert(s.members)
      .values({ orgId, userId: managerUserId, status: 'active' })
      .returning();
    managerMemberId = managerMember!.id;

    const [store] = await db
      .insert(s.stores)
      .values({ orgId, name: 'Main', code: 'MAIN' })
      .returning();
    storeId = store!.id;
    const [otherStore] = await db
      .insert(s.stores)
      .values({ orgId, name: 'Other', code: 'OTHER' })
      .returning();
    otherStoreId = otherStore!.id;
    await db.insert(s.memberRoleBindings).values([
      {
        memberId: managerMemberId,
        roleId: managerRoleId,
        scopeType: 'store',
        scopeId: storeId,
        grantedBy: adminUserId,
      },
      {
        memberId: managerMemberId,
        roleId: staffRoleId,
        scopeType: 'store',
        scopeId: storeId,
        grantedBy: adminUserId,
      },
    ]);
    await db.insert(s.memberStoreAssignments).values({
      memberId: managerMemberId,
      storeId,
      assignedBy: adminUserId,
    });
  });

  afterAll(async () => {
    if (!orgId) return;
    const db = getDb(undefined, { system: 'maintenance' });
    await db.delete(s.organizations).where(eq(s.organizations.id, orgId));
  });

  const adminSession = (): SessionContext => ({
    userId: adminUserId,
    memberId: adminMemberId,
    orgId,
    orgTimezone: 'UTC',
    permissions: new Set(['users.manage', 'org.admin']),
    roleSlugs: new Set(['admin']),
  });

  test('opening an invite creates the member, store and role in that org', async () => {
    const staff = await getDb(undefined, { system: 'maintenance' }).query.roles.findFirst({
      where: (r, { eq: eq2 }) => eq2(r.id, staffRoleId),
    });
    expect(staff).toBeTruthy();

    const created = await callerFor(adminSession()).admin.memberInviteCreate({
      roleSlug: staff!.slug,
      storeIds: [storeId],
    });
    expect(created.token.length).toBeGreaterThan(20);
    const tgUserId = freshTgId();
    const accepted = await callerFor(null).auth.acceptInvite({
      token: created.token,
      initData: signInitData(tgUserId, { firstName: 'Invited Person' }),
    });
    expect(accepted.session.member.orgId).toBe(orgId);
    expect(accepted.session.member.status).toBe('active');
    expect(accepted.session.stores.map((st) => st.id)).toContain(storeId);
    expect(accepted.session.roleSlugs).toContain(staff!.slug);
    expect(accepted.session.user.displayName).toBe('Invited Person');

    const list = await callerFor(adminSession()).admin.memberList();
    expect(list.some((m) => m.userId === accepted.session.user.id)).toBe(true);
  });

  test('the same invite cannot be accepted by a second Telegram user', async () => {
    const staff = await getDb(undefined, { system: 'maintenance' }).query.roles.findFirst({
      where: (r, { eq: eq2 }) => eq2(r.id, staffRoleId),
    });
    const created = await callerFor(adminSession()).admin.memberInviteCreate({
      roleSlug: staff!.slug,
      storeIds: [storeId],
    });
    await callerFor(null).auth.acceptInvite({
      token: created.token,
      initData: signInitData(freshTgId()),
    });
    await expect(
      callerFor(null).auth.acceptInvite({
        token: created.token,
        initData: signInitData(freshTgId()),
      }),
    ).rejects.toThrow('auth.errors.inviteUsed');
  });

  test('a store manager can invite only into their own store', async () => {
    const session: SessionContext = {
      userId: managerUserId,
      memberId: managerMemberId,
      orgId,
      orgTimezone: 'UTC',
      permissions: new Set(['users.manage']),
      roleSlugs: new Set(['manager']),
    };
    const staff = await getDb(undefined, { system: 'maintenance' }).query.roles.findFirst({
      where: (r, { eq: eq2 }) => eq2(r.id, staffRoleId),
    });
    const allowed = await callerFor(session).admin.memberInviteCreate({
      roleSlug: staff!.slug,
      storeIds: [storeId],
    });
    expect(allowed.token.length).toBeGreaterThan(20);

    await expect(
      callerFor(session).admin.memberInviteCreate({
        roleSlug: staff!.slug,
        storeIds: [otherStoreId],
      }),
    ).rejects.toThrow('admin.errors.notAdminOfStore');
  });

  // ---------- 2026-10-21 CA-19 / CA-17 / rename rank ----------------------

  const managerSession = (): SessionContext => ({
    userId: managerUserId,
    memberId: managerMemberId,
    orgId,
    orgTimezone: 'UTC',
    permissions: new Set(['users.manage']),
    roleSlugs: new Set(['manager']),
  });
  const staffSlug = async () =>
    (await getDb(undefined, { system: 'maintenance' }).query.roles.findFirst({
      where: (r, { eq: eq2 }) => eq2(r.id, staffRoleId),
    }))!.slug;
  const inviteIdOf = async (token: string) => {
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(token).digest('hex');
    const row = await getDb(undefined, { system: 'maintenance' }).query.memberInvites.findFirst({
      where: (i, { eq: eq2 }) => eq2(i.tokenHash, hash),
    });
    return row!.id;
  };

  test('CA-19 a revoked invite is gone from the list and cannot be accepted', async () => {
    const created = await callerFor(adminSession()).admin.memberInviteCreate({
      roleSlug: await staffSlug(),
      storeIds: [storeId],
    });
    const inviteId = await inviteIdOf(created.token);
    const before = await callerFor(adminSession()).admin.memberInviteList();
    expect(before.some((i) => i.id === inviteId)).toBe(true);

    await callerFor(adminSession()).admin.memberInviteRevoke({ inviteId });
    const after = await callerFor(adminSession()).admin.memberInviteList();
    expect(after.some((i) => i.id === inviteId)).toBe(false);
    await expect(callerFor(adminSession()).admin.memberInviteRevoke({ inviteId })).rejects.toThrow(
      'admin.errors.inviteNotPending',
    );

    const tgUserId = freshTgId();
    await expect(
      callerFor(null).auth.acceptInvite({ token: created.token, initData: signInitData(tgUserId) }),
    ).rejects.toThrow('auth.errors.inviteRevoked');
    const user = await getDb(undefined, { system: 'maintenance' }).query.users.findFirst({
      where: (u, { eq: eq2 }) => eq2(u.tgUserId, tgUserId),
    });
    expect(user).toBeUndefined();
    const audit = await getDb(undefined, { system: 'maintenance' }).query.policyDecisions.findMany({
      where: (pd, { and: and2, eq: eq2 }) =>
        and2(eq2(pd.orgId, orgId), eq2(pd.resourceId, inviteId)),
    });
    expect(audit.map((a) => a.action)).toContain('admin.memberInviteRevoke');
  });

  test('CA-19 a store manager lists and revokes only invites into their stores', async () => {
    const mine = await callerFor(managerSession()).admin.memberInviteCreate({
      roleSlug: await staffSlug(),
      storeIds: [storeId],
    });
    const theirs = await callerFor(adminSession()).admin.memberInviteCreate({
      roleSlug: await staffSlug(),
      storeIds: [otherStoreId],
    });
    const mineId = await inviteIdOf(mine.token);
    const theirsId = await inviteIdOf(theirs.token);
    const list = await callerFor(managerSession()).admin.memberInviteList();
    expect(list.some((i) => i.id === mineId)).toBe(true);
    expect(list.some((i) => i.id === theirsId)).toBe(false);
    await expect(
      callerFor(managerSession()).admin.memberInviteRevoke({ inviteId: theirsId }),
    ).rejects.toThrow('admin.errors.notAdminOfStore');
    await callerFor(managerSession()).admin.memberInviteRevoke({ inviteId: mineId });
  });

  test('CA-19 an invite dies with its inviter (suspended or lost users.manage)', async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    const created = await callerFor(managerSession()).admin.memberInviteCreate({
      roleSlug: await staffSlug(),
      storeIds: [storeId],
    });
    await db
      .update(s.members)
      .set({ status: 'suspended' })
      .where(eq(s.members.id, managerMemberId));
    try {
      await expect(
        callerFor(null).auth.acceptInvite({
          token: created.token,
          initData: signInitData(freshTgId()),
        }),
      ).rejects.toThrow('auth.errors.inviteInviterNoLongerAuthorized');
    } finally {
      await db.update(s.members).set({ status: 'active' }).where(eq(s.members.id, managerMemberId));
    }

    // Losing the store-level users.manage voids the link as well.
    const second = await callerFor(managerSession()).admin.memberInviteCreate({
      roleSlug: await staffSlug(),
      storeIds: [storeId],
    });
    await db.insert(s.memberPermissionOverrides).values({
      memberId: managerMemberId,
      permissionKey: 'users.manage',
      effect: 'deny',
      scopeType: 'store',
      scopeId: storeId,
    });
    try {
      await expect(
        callerFor(null).auth.acceptInvite({
          token: second.token,
          initData: signInitData(freshTgId()),
        }),
      ).rejects.toThrow('auth.errors.inviteInviterNoLongerAuthorized');
    } finally {
      await db
        .delete(s.memberPermissionOverrides)
        .where(eq(s.memberPermissionOverrides.memberId, managerMemberId));
    }
  });

  // ---------- 2026-11-09 COREAPI-07 / ADM1-02 ----------------------------

  /** An owner (rank 100, global org admin) who can hand out the admin role. */
  const makeOwner = async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    const suffix = Math.random().toString(36).slice(2, 9);
    const [ownerRole] = await db
      .insert(s.roles)
      .values({ orgId, slug: `owner-${suffix}`, name: 'Owner', rank: 100 })
      .returning();
    await db.insert(s.rolePermissions).values([
      { roleId: ownerRole!.id, permissionKey: 'users.manage' },
      { roleId: ownerRole!.id, permissionKey: 'org.admin' },
    ]);
    const [user] = await db
      .insert(s.users)
      .values({ tgUserId: freshTgId(), displayName: 'Owner', displayNameLocked: true })
      .returning();
    const [member] = await db
      .insert(s.members)
      .values({ orgId, userId: user!.id, status: 'active' })
      .returning();
    await db.insert(s.memberRoleBindings).values({
      memberId: member!.id,
      roleId: ownerRole!.id,
      scopeType: 'global',
      scopeId: null,
      grantedBy: adminUserId,
    });
    const session: SessionContext = {
      userId: user!.id,
      memberId: member!.id,
      orgId,
      orgTimezone: 'UTC',
      permissions: new Set(['users.manage', 'org.admin']),
      roleSlugs: new Set([ownerRole!.slug]),
    };
    /** Takes the owner role away, leaving `binding` instead. */
    const demoteTo = async (binding: {
      roleId: string;
      scopeType: 'global' | 'store';
      scopeId: string | null;
    }) => {
      await db.delete(s.memberRoleBindings).where(eq(s.memberRoleBindings.memberId, member!.id));
      await db
        .insert(s.memberRoleBindings)
        .values({ memberId: member!.id, grantedBy: adminUserId, ...binding });
    };
    return { session, demoteTo };
  };
  const adminSlug = async () =>
    (await getDb(undefined, { system: 'maintenance' }).query.roles.findFirst({
      where: (r, { eq: eq2 }) => eq2(r.id, adminRoleId),
    }))!.slug;

  test('COREAPI-07 an admin link dies once its inviter no longer outranks the role', async () => {
    const owner = await makeOwner();
    const created = await callerFor(owner.session).admin.memberInviteCreate({
      roleSlug: await adminSlug(),
      storeIds: [storeId],
    });
    const inviteId = await inviteIdOf(created.token);
    // Still a global org admin, but now at the role's own rank.
    await owner.demoteTo({ roleId: adminRoleId, scopeType: 'global', scopeId: null });
    const listed = await callerFor(adminSession()).admin.memberInviteList();
    expect(listed.some((i) => i.id === inviteId)).toBe(false);
    await expect(
      callerFor(null).auth.acceptInvite({
        token: created.token,
        initData: signInitData(freshTgId()),
      }),
    ).rejects.toThrow('auth.errors.inviteInviterNoLongerAuthorized');
  });

  test('COREAPI-07 … and once its inviter only manages the invite’s store', async () => {
    const owner = await makeOwner();
    const created = await callerFor(owner.session).admin.memberInviteCreate({
      roleSlug: await adminSlug(),
      storeIds: [storeId],
    });
    // users.manage over every store on the invite used to be enough.
    await owner.demoteTo({ roleId: managerRoleId, scopeType: 'store', scopeId: storeId });
    await expect(
      callerFor(null).auth.acceptInvite({
        token: created.token,
        initData: signInitData(freshTgId()),
      }),
    ).rejects.toThrow('auth.errors.inviteInviterNoLongerAuthorized');
  });

  test('ADM1-02 a role lowered below the admin tier does not arrive as a global binding', async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    const owner = await makeOwner();
    const slug = `regional-${Math.random().toString(36).slice(2, 9)}`;
    await callerFor(owner.session).admin.roleCreate({ slug, name: 'Regional', rank: 85 });
    const role = await db.query.roles.findFirst({
      where: (r, { and: and2, eq: eq2 }) => and2(eq2(r.orgId, orgId), eq2(r.slug, slug)),
    });
    const created = await callerFor(owner.session).admin.memberInviteCreate({
      roleSlug: slug,
      storeIds: [storeId],
    });
    // Nobody holds the role yet, so its level may still move.
    await callerFor(owner.session).admin.roleUpdate({ roleId: role!.id, rank: 70 });
    const accepted = await callerFor(null).auth.acceptInvite({
      token: created.token,
      initData: signInitData(freshTgId()),
    });
    expect(accepted.session.stores.map((st) => st.id)).toContain(storeId);
    const bindings = await db.query.memberRoleBindings.findMany({
      where: (b, { eq: eq2 }) => eq2(b.roleId, role!.id),
    });
    expect(bindings).toEqual([]);
  });

  test('CA-17 a store manager reads only their own stores and members', async () => {
    const mgr = callerFor(managerSession());
    const members = await mgr.admin.memberList();
    expect(members.some((m) => m.memberId === managerMemberId)).toBe(true);
    // The org admin has no store: not visible to a store manager.
    expect(members.some((m) => m.memberId === adminMemberId)).toBe(false);
    expect(members.every((m) => m.tgUserId === null)).toBe(true);
    for (const m of members) {
      expect(m.stores.every((st) => st.id === storeId)).toBe(true);
    }
    const stores = await mgr.admin.storeList();
    expect(stores.map((st) => st.id)).toEqual([storeId]);
    const audit = await mgr.admin.adminAuditList({ limit: 200 });
    expect(audit.every((r) => r.scopeStoreId === storeId)).toBe(true);
    expect(await mgr.admin.adminAuditList({ limit: 50, storeId: otherStoreId })).toEqual([]);
    const overview = await mgr.admin.overview();
    expect(overview.storeCount).toBe(1);
    await expect(mgr.admin.memberPermissionsList({ memberId: adminMemberId })).rejects.toThrow(
      'admin.errors.notAdminOfStore',
    );

    const adminView = await callerFor(adminSession()).admin.memberList();
    expect(adminView.some((m) => m.memberId === adminMemberId && m.tgUserId !== null)).toBe(true);
  });

  test('rename rank: an org admin cannot rename an equal-rank admin, only themself', async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    const [peerUser] = await db
      .insert(s.users)
      .values({ tgUserId: freshTgId(), displayName: 'Peer Admin', displayNameLocked: true })
      .returning();
    const [peer] = await db
      .insert(s.members)
      .values({ orgId, userId: peerUser!.id, status: 'active' })
      .returning();
    await db.insert(s.memberRoleBindings).values({
      memberId: peer!.id,
      roleId: adminRoleId,
      scopeType: 'global',
      scopeId: null,
      grantedBy: adminUserId,
    });
    await expect(
      callerFor(adminSession()).admin.memberSetDisplayName({
        memberId: peer!.id,
        displayName: 'Hijacked',
      }),
    ).rejects.toThrow('auth.errors.cannotRevokeEqualOrHigher');
    await callerFor(adminSession()).admin.memberSetDisplayName({
      memberId: adminMemberId,
      displayName: 'Admin Renamed Self',
    });
    const self = await db.query.users.findFirst({
      where: (u, { eq: eq2 }) => eq2(u.id, adminUserId),
    });
    expect(self?.displayName).toBe('Admin Renamed Self');
  });

  test('an unknown token creates nothing', async () => {
    const tgUserId = freshTgId();
    await expect(
      callerFor(null).auth.acceptInvite({
        token: 'A'.repeat(43),
        initData: signInitData(tgUserId),
      }),
    ).rejects.toThrow('auth.errors.inviteNotFound');
    const user = await getDb(undefined, { system: 'maintenance' }).query.users.findFirst({
      where: (u, { eq: eq2 }) => eq2(u.tgUserId, tgUserId),
    });
    expect(user).toBeUndefined();
  });
});
