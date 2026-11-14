/**
 * Review MWD-20 (modern-web-guidance: security, Clear-Site-Data), owner
 * decision 2026-11-14: a successful sign-out also asks the browser to drop
 * its HTTP cache for this site, so a shared phone keeps no cached copy of
 * the signed-out person's responses.
 *
 * Only `"cache"`. `"storage"` would also wipe the offline outbox
 * (IndexedDB), which can hold other people's queued writes on a shared
 * phone, and the service worker's offline shell. Not `"cookies"` either:
 * the one cookie, the refresh cookie (review MWD-14), is removed by
 * auth.signOut itself with a `Max-Age=0` Set-Cookie (http/refreshCookie.ts).
 *
 * tRPC builds its own Response, so the header is added after it, on the
 * calls whose path names `auth.signOut` (alone or in a batch).
 */
import type { MiddlewareHandler } from 'hono';

const SIGN_OUT = 'auth.signOut';

/** True when a /trpc request path calls sign-out (batched or not). */
export function callsSignOut(pathname: string): boolean {
  const prefix = '/trpc/';
  if (!pathname.startsWith(prefix)) return false;
  return pathname.slice(prefix.length).split(',').includes(SIGN_OUT);
}

export function clearSiteDataOnSignOut(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.req.method === 'POST' && c.res.ok && callsSignOut(c.req.path)) {
      c.res.headers.set('Clear-Site-Data', '"cache"');
    }
  };
}
