/**
 * Review MWD-14 (modern-web-guidance: privacy): the refresh token in an
 * HttpOnly cookie, so the web app no longer keeps it in localStorage,
 * where any script on the page (the Telegram SDK, an injected one) can
 * read it.
 *
 * Additive. Every sign-in and refresh still returns `tokens.refreshToken`
 * in its JSON, and `auth.refresh` still takes it from the body: that is
 * the Fine app's contract (bearer tokens, refresh token in the body), and
 * a body token always wins over the cookie. The cookie is only read when
 * the body has none AND the request carries {@link REFRESH_COOKIE_HEADER}:
 * a custom header cannot be sent cross-site without a CORS preflight, so a
 * form or a plain cross-site POST cannot rotate someone's session.
 *
 * Attributes:
 *   - production (HTTPS, behind the app-proxy Worker, same origin as the
 *     web app): `__Secure-` name; `HttpOnly; Secure; SameSite=None;
 *     Partitioned`. Telegram Web frames the app cross-site inside
 *     web.telegram.org, a CHIPS context: there a `SameSite=None;
 *     Partitioned` cookie is the only kind Chromium keeps. In Telegram's
 *     own WebViews the app is the top-level page and the cookie is an
 *     ordinary first-party one. A browser that does not keep it (Safari
 *     blocking third-party cookies in the frame) leaves the app on its
 *     fallbacks (the token held in memory, then Telegram's initData).
 *   - development and tests (plain http on localhost; the api on another
 *     port is still the same site): `HttpOnly; SameSite=Lax`, no `Secure`
 *     or `Partitioned`, which browsers refuse over http.
 *   - `Path=/trpc/auth.refresh`: the one call that reads it. The finding
 *     suggested this path; `/trpc` would send it with every request for
 *     nothing. Sign-out clears it with the same path from its own URL,
 *     which a Set-Cookie may do.
 *   - `Max-Age` = what is left of the refresh token's own lifetime (30
 *     days), so the cookie and the token end together.
 *   - No `Domain`: host-only, the host the browser sees (the Worker's).
 */
import type { Context } from 'hono';
import { generateCookie, getCookie } from 'hono/cookie';

/** The request header that lets `auth.refresh` read the cookie. */
export const REFRESH_COOKIE_HEADER = 'x-compass-refresh';
/** Its one value. */
export const REFRESH_COOKIE_HEADER_VALUE = 'cookie';
export const REFRESH_COOKIE_PATH = '/trpc/auth.refresh';

export function refreshCookieName(production: boolean): string {
  return production ? '__Secure-compass_rt' : 'compass_rt';
}

/** The Set-Cookie value for `token`, valid `maxAgeSeconds` (0 clears it). */
export function refreshCookieHeader(
  token: string,
  maxAgeSeconds: number,
  production: boolean,
): string {
  return generateCookie(refreshCookieName(production), token, {
    path: REFRESH_COOKIE_PATH,
    httpOnly: true,
    maxAge: Math.max(0, Math.floor(maxAgeSeconds)),
    ...(production ? { secure: true, sameSite: 'None', partitioned: true } : { sameSite: 'Lax' }),
  });
}

/** Seconds from now until `expiresAt`, never below zero. */
export function secondsUntil(expiresAt: Date | string, now: number = Date.now()): number {
  const at = typeof expiresAt === 'string' ? Date.parse(expiresAt) : expiresAt.getTime();
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.floor((at - now) / 1000));
}

/** Add the refresh cookie to the response `c` is building. */
export function setRefreshCookie(
  c: Context,
  token: string,
  expiresAt: Date | string,
  production: boolean,
): void {
  const maxAge = secondsUntil(expiresAt);
  if (maxAge <= 0) return;
  c.header('Set-Cookie', refreshCookieHeader(token, maxAge, production), { append: true });
}

/** Drop the refresh cookie (sign-out). */
export function clearRefreshCookie(c: Context, production: boolean): void {
  c.header('Set-Cookie', refreshCookieHeader('', 0, production), { append: true });
}

/**
 * The refresh token in the cookie, when the request asked for it to be
 * read (the header above); otherwise, or with no cookie, null.
 */
export function readRefreshCookie(c: Context, production: boolean): string | null {
  if (c.req.header(REFRESH_COOKIE_HEADER) !== REFRESH_COOKIE_HEADER_VALUE) return null;
  const value = getCookie(c, refreshCookieName(production));
  return value ? value : null;
}
