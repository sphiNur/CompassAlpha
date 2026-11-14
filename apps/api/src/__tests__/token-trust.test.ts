/**
 * Refresh tokens and the rate limiter, through the router and the real
 * request context (2026-10-30 review, area "tokens and trust"):
 *
 *   AUTH-12  a consumed token retried inside the grace window gets the
 *            successor it already had, never a second live one.
 *   B12      a token without a tracked row is refused.
 *   AUTH-11  switching organisation ends the chain being left.
 *   AUTH-6   the limiter ignores headers a client can write and puts
 *            callers without a trusted address in one shared bucket.
 *
 * The PG half is skipped when DATABASE_URL is unset OR SKIP_PG_TESTS=1.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { SignJWT } from 'jose';
import { getDb, provisionOrganization, schema as s, withSystemContext } from '@compass/db';
import { env } from '../env';
import { appRouter } from '../trpc/router';
import { AUTH_LIMIT } from '../trpc/routers/auth/limits';
import { createContext, type RequestContext } from '../trpc/context';
import { verifyRefresh } from '../infra/jwt';
import { trustedClientIp, CLIENT_IP_HEADER, PROXY_KEY_HEADER } from '../services/clientIp';
import {
  _resetRateBuckets,
  checkClientRate,
  UNIDENTIFIED_BUDGET_FACTOR,
} from '../services/rateLimit';
import { SHOULD_RUN as SHOULD_RUN_PG } from './helpers/pg';
import { signInitData, freshTgId } from './helpers/telegram';
import { errorOf } from './helpers/errors';
import { testHono } from './helpers/ctx';
import {
  REFRESH_COOKIE_HEADER,
  REFRESH_COOKIE_HEADER_VALUE,
  refreshCookieName,
} from '../http/refreshCookie';

const SHOULD_RUN = SHOULD_RUN_PG && !!env.TELEGRAM_BOT_TOKEN;

/** A caller built by the server's own createContext from these headers. */
async function callerWith(headers: Record<string, string> = {}) {
  const ctx = await createContext(null, testHono(headers) as unknown as RequestContext['hono']);
  return appRouter.createCaller(ctx);
}

const bearer = (accessToken: string) => ({ authorization: `Bearer ${accessToken}` });

describe('trustedClientIp (AUTH-6)', () => {
  const read = (h: Record<string, string>) => (name: string) => h[name];
  const KEY = 'k'.repeat(40);

  test('without the proxy key only cf-connecting-ip counts, never x-forwarded-for', () => {
    expect(trustedClientIp(read({ 'x-forwarded-for': '1.2.3.4' }), undefined)).toBeNull();
    expect(trustedClientIp(read({ 'cf-connecting-ip': '1.2.3.4' }), undefined)).toBe('1.2.3.4');
    expect(trustedClientIp(read({ 'cf-connecting-ip': 'not an ip' }), undefined)).toBeNull();
  });

  test('with the proxy key only the address the Worker vouches for counts', () => {
    const vouched = read({
      [PROXY_KEY_HEADER]: KEY,
      [CLIENT_IP_HEADER]: '2001:DB8::1',
      'cf-connecting-ip': '9.9.9.9',
    });
    expect(trustedClientIp(vouched, KEY)).toBe('2001:db8::1');
    const forged = read({
      [PROXY_KEY_HEADER]: 'wrong',
      [CLIENT_IP_HEADER]: '5.5.5.5',
      'cf-connecting-ip': '9.9.9.9',
    });
    expect(trustedClientIp(forged, KEY)).toBeNull();
    expect(trustedClientIp(read({ 'cf-connecting-ip': '9.9.9.9' }), KEY)).toBeNull();
  });

  test('callers without an address share one bucket with a larger budget', () => {
    _resetRateBuckets();
    const opts = { window: 60_000, max: 2 };
    expect(checkClientRate('t', '1.1.1.1', opts)).toBe(true);
    expect(checkClientRate('t', '1.1.1.1', opts)).toBe(true);
    expect(checkClientRate('t', '1.1.1.1', opts)).toBe(false);
    for (let i = 0; i < 2 * UNIDENTIFIED_BUDGET_FACTOR; i += 1) {
      expect(checkClientRate('t', null, opts)).toBe(true);
    }
    expect(checkClientRate('t', null, opts)).toBe(false);
    expect(checkClientRate('t', undefined, opts)).toBe(false);
    _resetRateBuckets();
  });
});

describe.skipIf(!SHOULD_RUN)('tokens and trust through the router (PG-gated)', () => {
  const db = () => getDb(undefined, { system: 'maintenance' });
  let userId = '';
  let tgUserId = 0n;
  let orgA = '';
  let orgB = '';

  beforeAll(async () => {
    _resetRateBuckets();
    tgUserId = freshTgId();
    const [user] = await db()
      .insert(s.users)
      .values({ tgUserId, displayName: 'Token Trust', displayNameLocked: true })
      .returning();
    userId = user!.id;
    const suffix = Math.random().toString(36).slice(2, 8);
    const provisioned = await withSystemContext(db(), 'maintenance', async (tx) => ({
      a: await provisionOrganization(tx, {
        name: 'Trust A',
        slug: `trust-a-${suffix}`,
        ownerUserId: userId,
      }),
      b: await provisionOrganization(tx, {
        name: 'Trust B',
        slug: `trust-b-${suffix}`,
        ownerUserId: userId,
      }),
    }));
    orgA = provisioned.a.orgId;
    orgB = provisioned.b.orgId;
  });

  // Each test signs in to A, as the user last left it. Some switch to B;
  // a test that fails half-way must not leave the next one in B (review
  // TEST2-09: each test used to move the user back at its end).
  beforeEach(async () => {
    await db().update(s.users).set({ lastOrgId: orgA }).where(eq(s.users.id, userId));
  });

  afterAll(async () => {
    _resetRateBuckets();
    for (const id of [orgA, orgB]) {
      if (id) await db().delete(s.organizations).where(eq(s.organizations.id, id));
    }
    if (userId) await db().delete(s.users).where(eq(s.users.id, userId));
  });

  const login = async () =>
    (await callerWith()).auth.telegramLogin({ initData: signInitData(tgUserId) });
  const refresh = async (refreshToken: string) =>
    (await callerWith()).auth.refresh({ refreshToken });

  test('AUTH-12: retrying one token inside the grace window returns the same successor', async () => {
    const { tokens } = await login();
    const first = await refresh(tokens.refreshToken);
    const second = await refresh(tokens.refreshToken);
    const third = await refresh(tokens.refreshToken);
    expect(second.tokens.refreshToken).toBe(first.tokens.refreshToken);
    expect(third.tokens.refreshToken).toBe(first.tokens.refreshToken);
    const { jti } = await verifyRefresh(tokens.refreshToken);
    const children = await db().query.refreshTokens.findMany({
      where: eq(s.refreshTokens.parentId, jti!),
    });
    expect(children.length).toBe(1);

    // One chain: once the successor is used, the original is a replay and
    // takes the whole family down with it.
    const next = await refresh(first.tokens.refreshToken);
    await expect(refresh(tokens.refreshToken)).rejects.toThrow('auth.errors.refreshReplayDetected');
    await expect(refresh(next.tokens.refreshToken)).rejects.toThrow(
      'auth.errors.refreshReplayDetected',
    );
  });

  test('AUTH-12: concurrent refreshes with one token all succeed with the same successor', async () => {
    const { tokens } = await login();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => refresh(tokens.refreshToken)),
    );
    expect(new Set(results.map((r) => r.tokens.refreshToken)).size).toBe(1);
    const next = await refresh(results[0]!.tokens.refreshToken);
    expect(next.session.user.id).toBe(userId);
  });

  test('B12: a token whose row is gone is refused, every time', async () => {
    const { tokens } = await login();
    const { jti } = await verifyRefresh(tokens.refreshToken);
    await db().delete(s.refreshTokens).where(eq(s.refreshTokens.id, jti!));
    await expect(refresh(tokens.refreshToken)).rejects.toThrow('auth.errors.invalidRefresh');
    await expect(refresh(tokens.refreshToken)).rejects.toThrow('auth.errors.invalidRefresh');
    // Nothing was issued for it.
    const rows = await db().query.refreshTokens.findMany({
      where: eq(s.refreshTokens.parentId, jti!),
    });
    expect(rows.length).toBe(0);
  });

  test('B12: a validly signed token without a jti is refused', async () => {
    const legacy = await new SignJWT({ sub: userId, family: randomUUID() })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('30d')
      .sign(new TextEncoder().encode(env.JWT_REFRESH_SECRET));
    await expect(refresh(legacy)).rejects.toThrow('auth.errors.invalidRefresh');
  });

  // Review MWD-14 (modern-web-guidance: privacy): the refresh cookie.
  /** The value of the refresh cookie a response set, '' when it cleared it. */
  const cookieIn = (setCookies: string[]): string | undefined => {
    const line = setCookies.find((c) => c.startsWith(`${refreshCookieName(false)}=`));
    return line === undefined ? undefined : decodeURIComponent(line.split(';')[0]!.split('=')[1]!);
  };
  const withCookie = (token: string) => ({
    cookie: `${refreshCookieName(false)}=${encodeURIComponent(token)}`,
    [REFRESH_COOKIE_HEADER]: REFRESH_COOKIE_HEADER_VALUE,
  });
  async function call(headers: Record<string, string> = {}) {
    const hono = testHono(headers);
    const ctx = await createContext(null, hono as unknown as RequestContext['hono']);
    return { caller: appRouter.createCaller(ctx), hono };
  }

  test('MWD-14: a sign-in sets the refresh cookie and still returns the token', async () => {
    _resetRateBuckets();
    const { caller, hono } = await call();
    const { tokens } = await caller.auth.telegramLogin({ initData: signInitData(tgUserId) });
    expect(tokens.refreshToken.split('.')).toHaveLength(3);
    expect(cookieIn(hono.setCookies)).toBe(tokens.refreshToken);
    expect(hono.setCookies[0]).toContain('HttpOnly');
    expect(hono.setCookies[0]).toContain('Path=/trpc/auth.refresh');
  });

  test('MWD-14: refresh by cookie rotates like the body and sets the successor', async () => {
    _resetRateBuckets();
    const { tokens } = await login();
    const { caller, hono } = await call(withCookie(tokens.refreshToken));
    const next = await caller.auth.refresh({});
    expect(next.session.user.id).toBe(userId);
    expect(next.tokens.refreshToken).not.toBe(tokens.refreshToken);
    expect(cookieIn(hono.setCookies)).toBe(next.tokens.refreshToken);
    // Same chain: the old token is now spent (inside the grace window it
    // gets the same successor, AUTH-12).
    const again = await refresh(tokens.refreshToken);
    expect(again.tokens.refreshToken).toBe(next.tokens.refreshToken);
  });

  test('MWD-14: the cookie is read only with the header, and the body wins', async () => {
    _resetRateBuckets();
    const { tokens } = await login();
    const noHeader = await call({ cookie: withCookie(tokens.refreshToken).cookie });
    await expect(noHeader.caller.auth.refresh({})).rejects.toThrow('auth.errors.invalidRefresh');
    await expect((await call()).caller.auth.refresh({})).rejects.toThrow(
      'auth.errors.invalidRefresh',
    );
    // A bad cookie next to a good body token: the body is used.
    const both = await call(withCookie('not-a-refresh-token-at-all-really'));
    const next = await both.caller.auth.refresh({ refreshToken: tokens.refreshToken });
    expect(next.session.user.id).toBe(userId);
    expect(cookieIn(both.hono.setCookies)).toBe(next.tokens.refreshToken);
  });

  test('MWD-14: sign-out clears the cookie and the token behind it', async () => {
    _resetRateBuckets();
    const { tokens } = await login();
    const out = await call(bearer(tokens.accessToken));
    await out.caller.auth.signOut();
    expect(cookieIn(out.hono.setCookies)).toBe('');
    expect(out.hono.setCookies[0]).toContain('Max-Age=0');
    const after = await call(withCookie(tokens.refreshToken));
    await expect(after.caller.auth.refresh({})).rejects.toThrow();
  });

  test('AUTH-11: switching organisation ends the refresh chain being left', async () => {
    const before = await login();
    expect(before.session.member.orgId).toBe(orgA);
    const switched = await (
      await callerWith(bearer(before.tokens.accessToken))
    ).auth.switchOrganization({ orgId: orgB });
    expect(switched.session.member.orgId).toBe(orgB);

    // R2-ADM-1: the old chain ended because of the switch, not a theft;
    // the answer says so instead of "all devices signed out".
    await expect(refresh(before.tokens.refreshToken)).rejects.toThrow(
      'auth.errors.refreshChainSwitched',
    );
    // The failed refresh did not move the remembered workspace back.
    const user = await db().query.users.findFirst({ where: eq(s.users.id, userId) });
    expect(user!.lastOrgId).toBe(orgB);

    const after = await refresh(switched.tokens.refreshToken);
    expect(after.session.member.orgId).toBe(orgB);
  });

  test('R2-ADM-1: a token rotated before the switch is also told the session moved', async () => {
    const before = await login();
    const rotated = await refresh(before.tokens.refreshToken);
    // Past the retry grace window, reusing the first token is normally a replay.
    const { jti } = await verifyRefresh(before.tokens.refreshToken);
    await db()
      .update(s.refreshTokens)
      .set({ revokedAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(s.refreshTokens.id, jti!));
    await (
      await callerWith(bearer(rotated.tokens.accessToken))
    ).auth.switchOrganization({
      orgId: orgB,
    });
    await expect(refresh(before.tokens.refreshToken)).rejects.toThrow(
      'auth.errors.refreshChainSwitched',
    );
    await expect(refresh(rotated.tokens.refreshToken)).rejects.toThrow(
      'auth.errors.refreshChainSwitched',
    );
  });

  test('AUTH-11: an access token from before the change still switches', async () => {
    const before = await login();
    const { signAccess } = await import('../infra/jwt');
    const legacyAccess = await signAccess({
      sub: userId,
      org: before.session.member.orgId,
      mid: before.session.member.memberId,
    });
    const switched = await (
      await callerWith(bearer(legacyAccess))
    ).auth.switchOrganization({
      orgId: orgB,
    });
    expect(switched.session.member.orgId).toBe(orgB);
  });

  test('AUTH-6: a new x-forwarded-for per request no longer escapes the login limit', async () => {
    _resetRateBuckets();
    let limited = 0;
    // Bad initData fails after the rate check, so nothing is written.
    for (let i = 0; i < AUTH_LIMIT.max * UNIDENTIFIED_BUDGET_FACTOR + 2; i += 1) {
      const caller = await callerWith({ 'x-forwarded-for': `10.0.${i >> 8}.${i & 255}` });
      const err = await errorOf(() => caller.auth.telegramLogin({ initData: 'hash=bad' }));
      if (err?.message === 'auth.errors.rateLimited') limited += 1;
    }
    expect(limited).toBeGreaterThan(0);

    // One address Cloudflare vouches for is limited on its own budget.
    _resetRateBuckets();
    const statuses: string[] = [];
    for (let i = 0; i < AUTH_LIMIT.max + 2; i += 1) {
      const caller = await callerWith({ 'cf-connecting-ip': '203.0.113.7' });
      const err = await errorOf(() => caller.auth.telegramLogin({ initData: 'hash=bad' }));
      if (err) statuses.push(err.message);
    }
    // Review TEST2-16: the budget comes from the router, not a copy of it.
    expect(statuses.slice(0, AUTH_LIMIT.max)).toEqual(
      Array(AUTH_LIMIT.max).fill('auth.errors.invalidInitData'),
    );
    expect(statuses.slice(AUTH_LIMIT.max)).toEqual([
      'auth.errors.rateLimited',
      'auth.errors.rateLimited',
    ]);
    _resetRateBuckets();
  });
});
