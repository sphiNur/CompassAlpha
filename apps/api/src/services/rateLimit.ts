/**
 * In-memory IP-bucket rate limiter (M0 hardening, 2026-05-05).
 *
 * Why in-memory + this simple:
 *   - The API runs as ONE Hono process on ONE Ubuntu box. No load
 *     balancer, no second replica. Process-local Map state IS the
 *     state — there's no second process to share with.
 *   - Telegram WebApp is the only client; absolute traffic is
 *     low (a single restaurant chain, ~50 staff). A 5MB Map of IP
 *     buckets is more than the whole org will ever produce.
 *   - When we move to a second replica or to Redis Streams, swap
 *     this for a Redis-backed token bucket. The shape stays.
 *
 * Bucket eviction: every entry has `resetAt`. The next call after
 * resetAt drops the row entirely. No background sweeper needed; rare
 * cold IPs just sit until a re-hit.
 *
 * Caller usage:
 *   const ok = checkRate('login', ip, { window: 60_000, max: 5 });
 *   if (!ok) throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'auth.errors.rateLimited' });
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

interface RateOptions {
  /** Window length in milliseconds (e.g. 60_000 for "5 per minute"). */
  window: number;
  /** Max hits allowed within `window`. */
  max: number;
}

/**
 * Returns `true` if the request is allowed (and increments the counter
 * as a side-effect), `false` if rate-limited. Caller decides what 4xx
 * to throw — this layer only judges.
 */
export function checkRate(scope: string, key: string, opts: RateOptions): boolean {
  const id = `${scope}:${key}`;
  const now = Date.now();
  const existing = buckets.get(id);
  if (!existing || existing.resetAt <= now) {
    buckets.set(id, { count: 1, resetAt: now + opts.window });
    return true;
  }
  if (existing.count >= opts.max) {
    return false;
  }
  existing.count += 1;
  return true;
}

/**
 * Key for callers with no trusted address (AUTH-6). They used to skip
 * the limit entirely; now they share one bucket with a larger budget,
 * so a whole office behind one unknown proxy is not locked out by a
 * single person's typos, while a script cannot loop forever.
 */
export const UNIDENTIFIED_CLIENT = 'unidentified';
export const UNIDENTIFIED_BUDGET_FACTOR = 10;

/** `checkRate` on the client address, or on the shared bucket without one. */
export function checkClientRate(
  scope: string,
  ip: string | null | undefined,
  opts: RateOptions,
): boolean {
  if (ip) return checkRate(scope, ip, opts);
  return checkRate(scope, UNIDENTIFIED_CLIENT, {
    window: opts.window,
    max: opts.max * UNIDENTIFIED_BUDGET_FACTOR,
  });
}

/** Test-only — reset the entire store. Never call in production code. */
export function _resetRateBuckets(): void {
  buckets.clear();
}
