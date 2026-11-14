/**
 * Review MWD-14 (modern-web-guidance: privacy): the refresh token's
 * HttpOnly cookie (http/refreshCookie.ts). The PG half (sign-in sets it,
 * refresh reads it, sign-out clears it) is in token-trust.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { RefreshInputSchema } from '@compass/contracts';
import {
  clearRefreshCookie,
  readRefreshCookie,
  REFRESH_COOKIE_HEADER,
  REFRESH_COOKIE_HEADER_VALUE,
  refreshCookieHeader,
  refreshCookieName,
  secondsUntil,
  setRefreshCookie,
} from '../http/refreshCookie';

const attrs = (header: string) => header.split('; ').slice(1).sort();

describe('refresh cookie attributes', () => {
  test('production: __Secure-, HttpOnly, Secure, SameSite=None, Partitioned, the refresh path', () => {
    const header = refreshCookieHeader('tok', 2_592_000, true);
    expect(header.startsWith('__Secure-compass_rt=tok;')).toBe(true);
    expect(attrs(header)).toEqual(
      [
        'HttpOnly',
        'Max-Age=2592000',
        'Partitioned',
        'Path=/trpc/auth.refresh',
        'SameSite=None',
        'Secure',
      ].sort(),
    );
    expect(header).not.toContain('Domain=');
  });

  test('development over http: Lax, no Secure or Partitioned', () => {
    const header = refreshCookieHeader('tok', 60, false);
    expect(header.startsWith('compass_rt=tok;')).toBe(true);
    expect(attrs(header)).toEqual(
      ['HttpOnly', 'Max-Age=60', 'Path=/trpc/auth.refresh', 'SameSite=Lax'].sort(),
    );
  });

  test('Max-Age follows the token: what is left of its lifetime', () => {
    const now = Date.parse('2026-11-14T00:00:00Z');
    expect(secondsUntil(new Date(now + 30 * 86_400_000), now)).toBe(2_592_000);
    expect(secondsUntil('2026-11-13T00:00:00Z', now)).toBe(0);
    expect(secondsUntil('not a date', now)).toBe(0);
  });

  test('set, clear and read on a Hono response', async () => {
    const app = new Hono();
    app.post('/set', (c) => {
      setRefreshCookie(c, 'abc', new Date(Date.now() + 3_600_000), true);
      return c.json({});
    });
    app.post('/expired', (c) => {
      setRefreshCookie(c, 'abc', new Date(Date.now() - 1), true);
      return c.json({});
    });
    app.post('/clear', (c) => {
      clearRefreshCookie(c, true);
      return c.json({});
    });
    app.post('/read', (c) => c.json({ token: readRefreshCookie(c, true) }));

    const set = (await app.request('/set', { method: 'POST' })).headers.get('set-cookie') ?? '';
    expect(set).toMatch(
      /^__Secure-compass_rt=abc; Max-Age=(3599|3600); Path=\/trpc\/auth\.refresh/,
    );
    expect(
      (await app.request('/expired', { method: 'POST' })).headers.get('set-cookie'),
    ).toBeNull();
    const cleared = (await app.request('/clear', { method: 'POST' })).headers.get('set-cookie');
    expect(cleared).toContain('__Secure-compass_rt=;');
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('Partitioned');

    const read = async (headers: Record<string, string>) =>
      (
        (await (await app.request('/read', { method: 'POST', headers })).json()) as {
          token: unknown;
        }
      ).token;
    const cookie = `${refreshCookieName(true)}=abc; other=1`;
    expect(await read({ cookie, [REFRESH_COOKIE_HEADER]: REFRESH_COOKIE_HEADER_VALUE })).toBe(
      'abc',
    );
    // Without the header (a cross-site form, a plain POST) it is not read.
    expect(await read({ cookie })).toBeNull();
    expect(await read({ [REFRESH_COOKIE_HEADER]: REFRESH_COOKIE_HEADER_VALUE })).toBeNull();
  });
});

describe('auth.refresh input (the Fine contract)', () => {
  test('the body token is still accepted, and may now be left out', () => {
    expect(RefreshInputSchema.safeParse({ refreshToken: 'x'.repeat(40) }).success).toBe(true);
    expect(RefreshInputSchema.safeParse({}).success).toBe(true);
    expect(RefreshInputSchema.safeParse({ refreshToken: 'short' }).success).toBe(false);
  });
});
