/**
 * auth.telegramLogin must not enrol strangers.
 *
 * A valid initData signature proves a Telegram identity, nothing more.
 * Login used to create a user row and an active membership in the
 * `default` org for anyone who opened the bot, and re-created the
 * membership of anyone an admin had removed.
 *
 * Skipped when DATABASE_URL is unset OR SKIP_PG_TESTS=1.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import { env } from '../env';
import { loadSession } from '../trpc/context';
import { revokeAllForUser } from '../services/refreshTokens';
import { SHOULD_RUN as SHOULD_RUN_PG } from './helpers/pg';
import { signInitData, freshTgId } from './helpers/telegram';
import { callerFor } from './helpers/ctx';
import { cleanUpAfterAll, noteOrg, noteUser } from './helpers/cleanup';

cleanUpAfterAll();

const SHOULD_RUN = SHOULD_RUN_PG && !!env.TELEGRAM_BOT_TOKEN;

// Random, not clock-derived: two tests in the same second must not share an id.
describe.skipIf(!SHOULD_RUN)('telegramLogin enrolment (PG-gated)', () => {
  let orgId = '';

  // Any query the sign-in path issues with neither a tenant nor a declared
  // system context fails this file outright, instead of quietly returning
  // nothing, which is what the tightened policies make it do in production.
  const probeBefore = process.env.DB_TENANT_PROBE;
  beforeAll(() => {
    process.env.DB_TENANT_PROBE = 'throw';
  });
  afterAll(() => {
    if (probeBefore === undefined) delete process.env.DB_TENANT_PROBE;
    else process.env.DB_TENANT_PROBE = probeBefore;
  });

  beforeAll(async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    // The old behaviour only fired when an org with this slug existed.
    // Removed after the file when this file made it (review TEST1-07).
    const [made] = await db
      .insert(s.organizations)
      .values({ slug: 'default', name: 'Default', localeDefault: 'en', timezone: 'UTC' })
      .onConflictDoNothing()
      .returning();
    if (made) noteOrg(made.id);
    const org = await db.query.organizations.findFirst({
      where: (o, { eq: eq2 }) => eq2(o.slug, 'default'),
    });
    orgId = org!.id;
  });

  test('an unknown Telegram user is rejected and leaves no rows behind', async () => {
    const tgUserId = freshTgId();
    await expect(
      callerFor(null).auth.telegramLogin({ initData: signInitData(tgUserId) }),
    ).rejects.toThrow('auth.errors.noMembership');
    const user = await getDb(undefined, { system: 'maintenance' }).query.users.findFirst({
      where: (u, { eq: eq2 }) => eq2(u.tgUserId, tgUserId),
    });
    expect(user).toBeUndefined();
  });

  test('the refresh token a login returns can actually be refreshed', async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    const tgUserId = freshTgId();
    const [user] = await db
      .insert(s.users)
      .values({ tgUserId, displayName: `tg:${tgUserId}` })
      .returning();
    noteUser(user!.id);
    await db.insert(s.members).values({ orgId, userId: user!.id, status: 'active' });

    const login = await callerFor(null).auth.telegramLogin({ initData: signInitData(tgUserId) });
    // Through the router, so the input schema is part of what is tested.
    const refreshed = await callerFor(null).auth.refresh({
      refreshToken: login.tokens.refreshToken,
    });
    expect(refreshed.session.user.id).toBe(user!.id);
    expect(refreshed.tokens.accessToken.length).toBeGreaterThan(20);
    expect(refreshed.tokens.refreshToken).not.toBe(login.tokens.refreshToken);

    // And again with the rotated token: the chain keeps working.
    const again = await callerFor(null).auth.refresh({
      refreshToken: refreshed.tokens.refreshToken,
    });
    expect(again.session.user.id).toBe(user!.id);

    // AUTH-10: signing out everywhere reports what it revoked (was always 0).
    expect(await revokeAllForUser(db, user!.id)).toBe(1);
    expect(await revokeAllForUser(db, user!.id)).toBe(0);
  });

  test('an invited member signs in; a removed or suspended one does not come back', async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    const tgUserId = freshTgId();
    const [user] = await db
      .insert(s.users)
      .values({ tgUserId, displayName: `tg:${tgUserId}` })
      .returning();
    noteUser(user!.id);
    const [member] = await db
      .insert(s.members)
      .values({ orgId, userId: user!.id, status: 'active' })
      .returning();
    const initData = signInitData(tgUserId);

    const ok = await callerFor(null).auth.telegramLogin({ initData });
    expect(ok.session.member.memberId).toBe(member!.id);

    await db.update(s.members).set({ status: 'suspended' }).where(eq(s.members.id, member!.id));
    // AUTH-19: a suspended member is told so, not "no membership".
    await expect(callerFor(null).auth.telegramLogin({ initData })).rejects.toThrow(
      'auth.errors.membershipSuspended',
    );

    await db.delete(s.refreshTokens).where(eq(s.refreshTokens.userId, user!.id));
    await db.delete(s.members).where(eq(s.members.id, member!.id));
    await expect(callerFor(null).auth.telegramLogin({ initData })).rejects.toThrow(
      'auth.errors.noMembership',
    );
    const members = await db.select().from(s.members).where(eq(s.members.userId, user!.id));
    expect(members.length).toBe(0);
  });

  /**
   * The whole of "my session ran out, I open the app again": sign in,
   * make a request, lose the session, sign in again. Every lookup on the
   * way happens before the server knows the tenant (who is this Telegram
   * user? which organisation are they in?) or just after (load their
   * roles), so this is the path that breaks first if tenant-less queries
   * are refused and one of them was not marked as a system lookup.
   */
  test('a member whose session has expired can sign in again', async () => {
    const fixtures = getDb(undefined, { system: 'maintenance' });
    const tgUserId = freshTgId();
    const [user] = await fixtures
      .insert(s.users)
      .values({ tgUserId, displayName: `tg:${tgUserId}` })
      .returning();
    noteUser(user!.id);
    const [member] = await fixtures
      .insert(s.members)
      .values({ orgId, userId: user!.id, status: 'active' })
      .returning();
    const initData = signInitData(tgUserId);

    const first = await callerFor(null).auth.telegramLogin({ initData });
    expect(first.session.member.memberId).toBe(member!.id);

    // What every later request does with the access token: load the member
    // and their permissions, on the server's own handle.
    const loaded = await loadSession(getDb(), user!.id, orgId, member!.id);
    expect(loaded?.memberId).toBe(member!.id);

    // The session is gone: every refresh token revoked, as after expiry or
    // a sign-out elsewhere.
    await fixtures
      .update(s.refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(s.refreshTokens.userId, user!.id));
    await expect(
      callerFor(null).auth.refresh({ refreshToken: first.tokens.refreshToken }),
    ).rejects.toThrow('auth.errors.refreshReplayDetected');

    const again = await callerFor(null).auth.telegramLogin({ initData });
    expect(again.session.member.memberId).toBe(member!.id);
    expect(again.session.member.orgId).toBe(orgId);
    const refreshed = await callerFor(null).auth.refresh({
      refreshToken: again.tokens.refreshToken,
    });
    expect(refreshed.session.user.id).toBe(user!.id);
  });

  test('a member added by Telegram ID signs in with their Telegram name, not tg:<id>', async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    const tgUserId = freshTgId();
    const [user] = await db
      .insert(s.users)
      .values({ tgUserId, displayName: `tg:${tgUserId}` })
      .returning();
    noteUser(user!.id);
    await db.insert(s.members).values({ orgId, userId: user!.id, status: 'active' });
    const initData = signInitData(tgUserId, { firstName: 'Smoke Staff' });

    const login = await callerFor(null).auth.telegramLogin({ initData });
    expect(login.session.user.displayName).toBe('Smoke Staff');
    expect(login.session.user.displayNameLocked).toBe(false);

    // A name that is not a placeholder is never replaced.
    await db
      .update(s.users)
      .set({ displayName: 'Smoke Staff, renamed' })
      .where(eq(s.users.id, user!.id));
    const again = await callerFor(null).auth.telegramLogin({ initData });
    expect(again.session.user.displayName).toBe('Smoke Staff, renamed');
  });

  test("Telegram's raw language code is kept as one of the four (COREWEB2-10)", async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    // Granted from the CLI or an invite: no language yet.
    const tgUserId = freshTgId();
    const [user] = await db
      .insert(s.users)
      .values({ tgUserId, displayName: `tg:${tgUserId}` })
      .returning();
    noteUser(user!.id);
    await db.insert(s.members).values({ orgId, userId: user!.id, status: 'active' });
    const login = await callerFor(null).auth.telegramLogin({
      initData: signInitData(tgUserId, { languageCode: 'zh-hans' }),
    });
    expect(login.session.user.locale).toBe('zh');
    const stored = await db.query.users.findFirst({
      where: (u, { eq: eq2 }) => eq2(u.id, user!.id),
    });
    expect(stored?.locale).toBe('zh');

    // One stored raw by an earlier sign-in is read, and kept, as one too.
    const earlier = freshTgId();
    const [old] = await db
      .insert(s.users)
      .values({ tgUserId: earlier, displayName: `tg:${earlier}`, locale: 'ru-RU' })
      .returning();
    noteUser(old!.id);
    await db.insert(s.members).values({ orgId, userId: old!.id, status: 'active' });
    const again = await callerFor(null).auth.telegramLogin({ initData: signInitData(earlier) });
    expect(again.session.user.locale).toBe('ru');
    const kept = await db.query.users.findFirst({ where: (u, { eq: eq2 }) => eq2(u.id, old!.id) });
    expect(kept?.locale).toBe('ru');
  });

  test('with no organisation to go back to, sign-in opens the one joined first (COREAPI-34)', async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    const tgUserId = freshTgId();
    const [user] = await db
      .insert(s.users)
      .values({ tgUserId, displayName: `tg:${tgUserId}` })
      .returning();
    noteUser(user!.id);
    const orgs: string[] = [];
    for (const label of ['a', 'b', 'c']) {
      const [org] = await db
        .insert(s.organizations)
        .values({
          slug: `first-joined-${tgUserId}-${label}`,
          name: `First joined ${label}`,
          localeDefault: 'en',
          timezone: 'UTC',
        })
        .returning({ id: s.organizations.id });
      orgs.push(noteOrg(org!.id));
    }
    // Read without an order, the memberships come back by organisation id
    // (members_org_user_unique), so the one joined first has the largest.
    const [second, third, first] = [...orgs].sort() as [string, string, string];
    const day = 86_400_000;
    const start = Date.now() - 10 * day;
    await db.insert(s.members).values([
      { orgId: second, userId: user!.id, status: 'active', joinedAt: new Date(start + day) },
      { orgId: first, userId: user!.id, status: 'active', joinedAt: new Date(start) },
      { orgId: third, userId: user!.id, status: 'active', joinedAt: new Date(start + 2 * day) },
    ]);
    const initData = signInitData(tgUserId);

    const login = await callerFor(null).auth.telegramLogin({ initData });
    expect(login.session.member.orgId).toBe(first);

    // The organisation they were last in opens while they are active there,
    await db.update(s.users).set({ lastOrgId: third }).where(eq(s.users.id, user!.id));
    const back = await callerFor(null).auth.telegramLogin({ initData });
    expect(back.session.member.orgId).toBe(third);

    // and once they are not, the first one they joined does again.
    await db
      .update(s.members)
      .set({ status: 'suspended' })
      .where(and(eq(s.members.userId, user!.id), eq(s.members.orgId, third)));
    const again = await callerFor(null).auth.telegramLogin({ initData });
    expect(again.session.member.orgId).toBe(first);
  });
});
