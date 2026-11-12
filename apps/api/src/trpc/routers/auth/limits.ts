/**
 * How often each sign-in path may be called from one address.
 */
import { TRPCError } from '@trpc/server';
import { checkClientRate } from '../../../services/rateLimit';

/**
 * Brute-force defence on the two public auth endpoints (added 2026-05-05).
 *
 * `telegramLogin` is the highest-value target: an attacker hammering
 * arbitrary `initData` blobs probes for HMAC weaknesses or ages out
 * Telegram's `auth_date` window. `refresh` is similar — feeding random
 * refresh tokens until something verifies.
 *
 * 5 attempts per IP per minute is generous for a real Telegram WebApp
 * client (which only re-logs in on app restart) but tight enough that
 * a credential-stuffing bot dies in ~12 minutes per IP. Telegram's
 * own bot constraints already limit per-user open rate, so this is
 * defence-in-depth rather than the primary line.
 *
 * The address comes from `ctx.trustedIp` (services/clientIp.ts): the
 * one the app-proxy Worker vouches for, never a header the client can
 * write (AUTH-6). Callers without one share a bucket with a larger
 * budget instead of escaping the limit.
 */
export const AUTH_LIMIT = { window: 60_000, max: 5 } as const;
/**
 * Refresh is not a guessing surface: it needs a token we signed. It is
 * also called by every client every 15 minutes, and a whole restaurant
 * shares one address behind its Wi-Fi, so the login budget is far too
 * small for it.
 */
const REFRESH_LIMIT = { window: 60_000, max: 60 } as const;
/**
 * A store often onboards several people from the same Wi-Fi. The token
 * itself is 256-bit, so this is not a guessing surface; the limit only
 * stops a client that loops on a broken link.
 */
const INVITE_LIMIT = { window: 60_000, max: 30 } as const;
export function enforceRate(scope: string, ip: string | null | undefined): void {
  const limit =
    scope === 'refresh' ? REFRESH_LIMIT : scope === 'acceptInvite' ? INVITE_LIMIT : AUTH_LIMIT;
  if (!checkClientRate(scope, ip, limit)) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: 'auth.errors.rateLimited',
    });
  }
}
