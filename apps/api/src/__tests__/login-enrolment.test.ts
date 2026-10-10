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
import { beforeAll, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema as s, withOrgContext } from '@compass/db';
import { env } from '../env';
import { logger } from '../infra/log';
import { appRouter } from '../trpc/router';
import type { RequestContext } from '../trpc/context';

const SHOULD_RUN =
  !!process.env.DATABASE_URL && process.env.SKIP_PG_TESTS !== '1' && !!env.TELEGRAM_BOT_TOKEN;

function signInitData(tgUserId: bigint): string {
  const fields: Record<string, string> = {
    auth_date: Math.floor(Date.now() / 1000).toString(),
    user: JSON.stringify({ id: Number(tgUserId), first_name: 'Enrol', username: `u${tgUserId}` }),
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

function anonymousCaller() {
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
    session: null,
    async withOrg(fn, options) {
      return withOrgContext(db, null, fn, options);
    },
  };
  return appRouter.createCaller(ctx);
}

// Random, not clock-derived: two tests in the same second must not share an id.
const freshTgId = () => BigInt(7_000_000_000 + Math.floor(Math.random() * 2_000_000_000));

describe.skipIf(!SHOULD_RUN)('telegramLogin enrolment (PG-gated)', () => {
  let orgId = '';

  beforeAll(async () => {
    const db = getDb();
    // The old behaviour only fired when an org with this slug existed.
    await db
      .insert(s.organizations)
      .values({ slug: 'default', name: 'Default', localeDefault: 'en', timezone: 'UTC' })
      .onConflictDoNothing();
    const org = await db.query.organizations.findFirst({
      where: (o, { eq: eq2 }) => eq2(o.slug, 'default'),
    });
    orgId = org!.id;
  });

  test('an unknown Telegram user is rejected and leaves no rows behind', async () => {
    const tgUserId = freshTgId();
    await expect(
      anonymousCaller().auth.telegramLogin({ initData: signInitData(tgUserId) }),
    ).rejects.toThrow('auth.errors.noMembership');
    const user = await getDb().query.users.findFirst({
      where: (u, { eq: eq2 }) => eq2(u.tgUserId, tgUserId),
    });
    expect(user).toBeUndefined();
  });

  test('the refresh token a login returns can actually be refreshed', async () => {
    const db = getDb();
    const tgUserId = freshTgId();
    const [user] = await db
      .insert(s.users)
      .values({ tgUserId, displayName: `tg:${tgUserId}` })
      .returning();
    await db.insert(s.members).values({ orgId, userId: user!.id, status: 'active' });

    const login = await anonymousCaller().auth.telegramLogin({ initData: signInitData(tgUserId) });
    // Through the router, so the input schema is part of what is tested.
    const refreshed = await anonymousCaller().auth.refresh({
      refreshToken: login.tokens.refreshToken,
    });
    expect(refreshed.session.user.id).toBe(user!.id);
    expect(refreshed.tokens.accessToken.length).toBeGreaterThan(20);
    expect(refreshed.tokens.refreshToken).not.toBe(login.tokens.refreshToken);

    // And again with the rotated token: the chain keeps working.
    const again = await anonymousCaller().auth.refresh({
      refreshToken: refreshed.tokens.refreshToken,
    });
    expect(again.session.user.id).toBe(user!.id);
  });

  test('an invited member signs in; a removed or suspended one does not come back', async () => {
    const db = getDb();
    const tgUserId = freshTgId();
    const [user] = await db
      .insert(s.users)
      .values({ tgUserId, displayName: `tg:${tgUserId}` })
      .returning();
    const [member] = await db
      .insert(s.members)
      .values({ orgId, userId: user!.id, status: 'active' })
      .returning();
    const initData = signInitData(tgUserId);

    const ok = await anonymousCaller().auth.telegramLogin({ initData });
    expect(ok.session.member.memberId).toBe(member!.id);

    await db.update(s.members).set({ status: 'suspended' }).where(eq(s.members.id, member!.id));
    await expect(anonymousCaller().auth.telegramLogin({ initData })).rejects.toThrow(
      'auth.errors.noMembership',
    );

    await db.delete(s.refreshTokens).where(eq(s.refreshTokens.userId, user!.id));
    await db.delete(s.members).where(eq(s.members.id, member!.id));
    await expect(anonymousCaller().auth.telegramLogin({ initData })).rejects.toThrow(
      'auth.errors.noMembership',
    );
    const members = await db.select().from(s.members).where(eq(s.members.userId, user!.id));
    expect(members.length).toBe(0);
  });
});
