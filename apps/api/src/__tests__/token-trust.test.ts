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
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHmac, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { SignJWT } from 'jose';
import { getDb, provisionOrganization, schema as s, withSystemContext } from '@compass/db';
import { env } from '../env';
import { appRouter } from '../trpc/router';
import { createContext } from '../trpc/context';
import { verifyRefresh } from '../infra/jwt';
import { trustedClientIp, CLIENT_IP_HEADER, PROXY_KEY_HEADER } from '../services/clientIp';
import {
  _resetRateBuckets,
  checkClientRate,
  UNIDENTIFIED_BUDGET_FACTOR,
} from '../services/rateLimit';

const SHOULD_RUN =
  !!process.env.DATABASE_URL && process.env.SKIP_PG_TESTS !== '1' && !!env.TELEGRAM_BOT_TOKEN;

function signInitData(tgUserId: bigint): string {
  const fields: Record<string, string> = {
    auth_date: Math.floor(Date.now() / 1000).toString(),
    user: JSON.stringify({ id: Number(tgUserId), first_name: 'Trust', username: `t${tgUserId}` }),
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

/** A caller built by the server's own createContext from these headers. */
async function callerWith(headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const hono = { req: { header: (name: string) => lower[name.toLowerCase()] } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = await createContext(null, hono as any);
  return appRouter.createCaller(ctx);
}

const bearer = (accessToken: string) => ({ authorization: `Bearer ${accessToken}` });

const freshTgId = () => BigInt(7_000_000_000 + Math.floor(Math.random() * 2_000_000_000));

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
    await expect(refresh(next.tokens.refreshToken)).rejects.toThrow();
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

  test('AUTH-11: switching organisation ends the refresh chain being left', async () => {
    const before = await login();
    expect(before.session.member.orgId).toBe(orgA);
    const switched = await (
      await callerWith(bearer(before.tokens.accessToken))
    ).auth.switchOrganization({ orgId: orgB });
    expect(switched.session.member.orgId).toBe(orgB);

    await expect(refresh(before.tokens.refreshToken)).rejects.toThrow();
    // The failed refresh did not move the remembered workspace back.
    const user = await db().query.users.findFirst({ where: eq(s.users.id, userId) });
    expect(user!.lastOrgId).toBe(orgB);

    const after = await refresh(switched.tokens.refreshToken);
    expect(after.session.member.orgId).toBe(orgB);
    await db().update(s.users).set({ lastOrgId: orgA }).where(eq(s.users.id, userId));
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
    await db().update(s.users).set({ lastOrgId: orgA }).where(eq(s.users.id, userId));
  });

  test('AUTH-6: a new x-forwarded-for per request no longer escapes the login limit', async () => {
    _resetRateBuckets();
    let limited = 0;
    // Bad initData fails after the rate check, so nothing is written.
    for (let i = 0; i < 5 * UNIDENTIFIED_BUDGET_FACTOR + 2; i += 1) {
      const caller = await callerWith({ 'x-forwarded-for': `10.0.${i >> 8}.${i & 255}` });
      try {
        await caller.auth.telegramLogin({ initData: 'hash=bad' });
      } catch (err) {
        if ((err as Error).message === 'auth.errors.rateLimited') limited += 1;
      }
    }
    expect(limited).toBeGreaterThan(0);

    // One address Cloudflare vouches for is limited on its own budget.
    _resetRateBuckets();
    const statuses: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const caller = await callerWith({ 'cf-connecting-ip': '203.0.113.7' });
      try {
        await caller.auth.telegramLogin({ initData: 'hash=bad' });
      } catch (err) {
        statuses.push((err as Error).message);
      }
    }
    expect(statuses.slice(0, 5).every((m) => m === 'auth.errors.invalidInitData')).toBe(true);
    expect(statuses.slice(5)).toEqual(['auth.errors.rateLimited', 'auth.errors.rateLimited']);
    _resetRateBuckets();
  });
});
