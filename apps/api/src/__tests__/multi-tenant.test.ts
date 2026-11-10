/**
 * Product-level multi-tenancy: one Telegram identity can belong to
 * several organisations, switching must survive a refresh-token
 * rotation, and creating a workspace must produce a usable tenant.
 *
 * Skipped when DATABASE_URL is unset OR SKIP_PG_TESTS=1.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { getDb, provisionOrganization, schema as s, withSystemContext } from '@compass/db';
import { env } from '../env';
import type { SessionContext } from '../trpc/context';
import { SHOULD_RUN as SHOULD_RUN_PG } from './helpers/pg';
import { signInitData, freshTgId } from './helpers/telegram';
import { callerFor } from './helpers/ctx';

const SHOULD_RUN = SHOULD_RUN_PG && !!env.TELEGRAM_BOT_TOKEN;

describe.skipIf(!SHOULD_RUN)('multi-tenant accounts (PG-gated)', () => {
  const cleanupOrgIds: string[] = [];
  const cleanupUserIds: string[] = [];
  let userId = '';
  let memberA = '';
  let memberB = '';
  let orgA = '';
  let orgB = '';
  let normalUserId = '';
  let tgUserId = 0n;

  beforeAll(async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    tgUserId = freshTgId();
    const [user] = await db
      .insert(s.users)
      .values({
        tgUserId,
        displayName: 'Multi Tenant',
        displayNameLocked: true,
      })
      .returning();
    userId = user!.id;
    cleanupUserIds.push(userId);
    await db.insert(s.platformAdmins).values({ userId, note: 'multi-tenant test' });

    const suffix = Math.random().toString(36).slice(2, 8);
    const provisioned = await withSystemContext(db, 'maintenance', async (tx) => {
      const a = await provisionOrganization(tx, {
        name: 'Org A',
        slug: `org-a-${suffix}`,
        ownerUserId: userId,
      });
      const b = await provisionOrganization(tx, {
        name: 'Org B',
        slug: `org-b-${suffix}`,
        ownerUserId: userId,
      });
      return { a, b };
    });
    orgA = provisioned.a.orgId;
    orgB = provisioned.b.orgId;
    memberA = provisioned.a.ownerMemberId!;
    memberB = provisioned.b.ownerMemberId!;
    cleanupOrgIds.push(orgA, orgB);

    const [normalUser] = await db
      .insert(s.users)
      .values({
        tgUserId: freshTgId(),
        displayName: 'Normal Admin',
        displayNameLocked: true,
      })
      .returning();
    normalUserId = normalUser!.id;
    cleanupUserIds.push(normalUserId);
    await db.insert(s.members).values({ orgId: orgA, userId: normalUserId, status: 'active' });
  });

  // Each test starts with the user last in B. One switches to A (review
  // NEW-RAND-01: run in another order, the login test found them in A).
  beforeEach(async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    await db.update(s.users).set({ lastOrgId: orgB }).where(eq(s.users.id, userId));
  });

  afterAll(async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    for (const id of cleanupOrgIds) {
      await db.delete(s.organizations).where(eq(s.organizations.id, id));
    }
    for (const id of cleanupUserIds) {
      await db.delete(s.users).where(eq(s.users.id, id));
    }
  });

  test('login reopens the last workspace and lists every membership', async () => {
    const login = await callerFor(null).auth.telegramLogin({ initData: signInitData(tgUserId) });
    expect(login.session.member.orgId).toBe(orgB);
    expect(login.session.member.memberId).toBe(memberB);
    expect(login.session.memberships.map((m) => m.orgId).sort()).toEqual([orgA, orgB].sort());
    expect(login.session.roleSlugs).toContain('super_admin');
    expect(login.session.isPlatformAdmin).toBe(true);
  });

  test('switching organisation survives a refresh-token rotation', async () => {
    const login = await callerFor(null).auth.telegramLogin({ initData: signInitData(tgUserId) });
    const sessionB: SessionContext = {
      userId,
      memberId: login.session.member.memberId,
      orgId: orgB,
      orgTimezone: 'UTC',
      permissions: new Set(['users.manage', 'org.admin']),
      roleSlugs: new Set(['admin']),
    };
    const switched = await callerFor(sessionB).auth.switchOrganization({ orgId: orgA });
    expect(switched.session.member.orgId).toBe(orgA);

    const refreshed = await callerFor(null).auth.refresh({
      refreshToken: switched.tokens.refreshToken,
    });
    expect(refreshed.session.member.orgId).toBe(orgA);
    expect(refreshed.session.member.memberId).toBe(memberA);
  });

  test('creating a workspace provisions roles, defaults and a Super Admin owner', async () => {
    // A platform admin of the test's own, in one workspace, so the shared
    // user keeps exactly A and B for the login test (review NEW-RAND-01).
    const db = getDb(undefined, { system: 'maintenance' });
    const [founder] = await db
      .insert(s.users)
      .values({ tgUserId: freshTgId(), displayName: 'Founder', displayNameLocked: true })
      .returning();
    cleanupUserIds.push(founder!.id);
    await db.insert(s.platformAdmins).values({ userId: founder!.id, note: 'multi-tenant test' });
    const home = await withSystemContext(db, 'maintenance', (tx) =>
      provisionOrganization(tx, {
        name: 'Founder home',
        slug: `founder-${Math.random().toString(36).slice(2, 8)}`,
        ownerUserId: founder!.id,
      }),
    );
    cleanupOrgIds.push(home.orgId);
    const founderSession: SessionContext = {
      userId: founder!.id,
      memberId: home.ownerMemberId!,
      orgId: home.orgId,
      orgTimezone: 'UTC',
      permissions: new Set(['users.manage', 'org.admin']),
      roleSlugs: new Set(['admin']),
    };
    const created = await callerFor(founderSession).auth.createOrganization({
      name: 'Brand New Restaurant',
      locale: 'en',
      timezone: 'Asia/Tashkent',
    });
    cleanupOrgIds.push(created.session.member.orgId);

    expect(created.session.member.orgId).not.toBe(home.orgId);
    // 2026-10-24: the owner is Super Admin, so they can appoint admins.
    expect(created.session.roleSlugs).toContain('super_admin');
    expect(created.session.myMaxRank).toBe(100);
    expect(created.session.permissions).toContain('org.admin');
    expect(created.session.isPlatformAdmin).toBe(true);
    expect(created.session.memberships).toHaveLength(2);

    const roles = await db
      .select()
      .from(s.roles)
      .where(eq(s.roles.orgId, created.session.member.orgId));
    expect(roles.some((r) => r.slug === 'admin' && r.isBuiltIn)).toBe(true);
    const flags = await db
      .select()
      .from(s.featureFlags)
      .where(eq(s.featureFlags.orgId, created.session.member.orgId));
    expect(flags.length).toBeGreaterThanOrEqual(4);
    const owner = await db.query.members.findFirst({
      where: (m, { eq: eq2, and: and2 }) =>
        and2(eq2(m.orgId, created.session.member.orgId), eq2(m.userId, created.session.user.id)),
    });
    expect(owner?.status).toBe('active');
  });

  test('an ordinary organisation admin cannot create another tenant', async () => {
    const member = await getDb(undefined, { system: 'maintenance' }).query.members.findFirst({
      where: (m, { eq: eq2, and: and2 }) => and2(eq2(m.orgId, orgA), eq2(m.userId, normalUserId)),
    });
    const session: SessionContext = {
      userId: normalUserId,
      memberId: member!.id,
      orgId: orgA,
      orgTimezone: 'UTC',
      permissions: new Set(['users.manage', 'org.admin']),
      roleSlugs: new Set(['admin']),
    };
    await expect(
      callerFor(session).auth.createOrganization({ name: 'Unauthorized Tenant' }),
    ).rejects.toThrow('auth.errors.platformAdminRequired');
  });
});
