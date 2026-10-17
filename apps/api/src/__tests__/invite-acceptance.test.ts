/**
 * A shared invite link must create the member, store assignment and
 * role binding when the recipient opens it. This is the regression
 * for "I accepted the invite but I am not in the system": the old
 * link only opened the bot and never wrote a membership.
 *
 * Skipped when DATABASE_URL is unset OR SKIP_PG_TESTS=1.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema as s, withOrgContext } from '@compass/db';
import { env } from '../env';
import { logger } from '../infra/log';
import { appRouter } from '../trpc/router';
import type { RequestContext, SessionContext } from '../trpc/context';

const SHOULD_RUN =
  !!process.env.DATABASE_URL && process.env.SKIP_PG_TESTS !== '1' && !!env.TELEGRAM_BOT_TOKEN;

function signInitData(tgUserId: bigint, firstName = 'New'): string {
  const fields: Record<string, string> = {
    auth_date: Math.floor(Date.now() / 1000).toString(),
    user: JSON.stringify({
      id: Number(tgUserId),
      first_name: firstName,
      username: `invitee${tgUserId}`,
    }),
  };
  const dataCheckString = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(env.TELEGRAM_BOT_TOKEN!).digest();
  const params = new URLSearchParams(fields);
  params.set('hash', createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return params.toString();
}

function caller(session: SessionContext | null) {
  const db = getDb();
  const ctx: RequestContext = {
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
      return withOrgContext(db, session?.orgId ?? null, fn);
    },
  };
  return appRouter.createCaller(ctx);
}

const freshTgId = () => BigInt(7_000_000_000 + Math.floor(Math.random() * 2_000_000_000));

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

    const created = await caller(adminSession()).admin.memberInviteCreate({
      roleSlug: staff!.slug,
      storeIds: [storeId],
    });
    expect(created.token.length).toBeGreaterThan(20);
    const tgUserId = freshTgId();
    const accepted = await caller(null).auth.acceptInvite({
      token: created.token,
      initData: signInitData(tgUserId, 'Invited Person'),
    });
    expect(accepted.session.member.orgId).toBe(orgId);
    expect(accepted.session.member.status).toBe('active');
    expect(accepted.session.stores.map((st) => st.id)).toContain(storeId);
    expect(accepted.session.roleSlugs).toContain(staff!.slug);
    expect(accepted.session.user.displayName).toBe('Invited Person');

    const list = await caller(adminSession()).admin.memberList();
    expect(list.some((m) => m.userId === accepted.session.user.id)).toBe(true);
  });

  test('the same invite cannot be accepted by a second Telegram user', async () => {
    const staff = await getDb(undefined, { system: 'maintenance' }).query.roles.findFirst({
      where: (r, { eq: eq2 }) => eq2(r.id, staffRoleId),
    });
    const created = await caller(adminSession()).admin.memberInviteCreate({
      roleSlug: staff!.slug,
      storeIds: [storeId],
    });
    await caller(null).auth.acceptInvite({
      token: created.token,
      initData: signInitData(freshTgId()),
    });
    await expect(
      caller(null).auth.acceptInvite({
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
    const allowed = await caller(session).admin.memberInviteCreate({
      roleSlug: staff!.slug,
      storeIds: [storeId],
    });
    expect(allowed.token.length).toBeGreaterThan(20);

    await expect(
      caller(session).admin.memberInviteCreate({
        roleSlug: staff!.slug,
        storeIds: [otherStoreId],
      }),
    ).rejects.toThrow('admin.errors.notAdminOfStore');
  });

  test('an unknown token creates nothing', async () => {
    const tgUserId = freshTgId();
    await expect(
      caller(null).auth.acceptInvite({
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
