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
 * resetAt replaces the row. Review (2026-11-23): a row was only ever
 * replaced by a re-hit, so callers from ever-new addresses grew the map
 * for the life of the process; every SWEEP_EVERY calls the expired rows
 * are now dropped.
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

/** Calls between two sweeps of the expired buckets. */
export const SWEEP_EVERY = 1_000;
let callsSinceSweep = 0;

function sweepExpired(now: number): void {
  callsSinceSweep += 1;
  if (callsSinceSweep < SWEEP_EVERY) return;
  callsSinceSweep = 0;
  for (const [id, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(id);
}

interface RateOptions {
  /** Window length in milliseconds (e.g. 60_000 for "5 per minute"). */
  window: number;
  /** Max hits allowed within `window`. */
  max: number;
}

/**
 * Returns `true` if the request is allowed (and adds `cost` to the
 * counter as a side-effect), `false` if rate-limited. Caller decides what
 * 4xx to throw — this layer only judges. `cost` (default 1) lets a
 * budget count something other than calls, e.g. bytes stored.
 */
export function checkRate(scope: string, key: string, opts: RateOptions, cost = 1): boolean {
  const id = `${scope}:${key}`;
  const now = Date.now();
  sweepExpired(now);
  const existing = buckets.get(id);
  if (!existing || existing.resetAt <= now) {
    if (cost > opts.max) return false;
    buckets.set(id, { count: cost, resetAt: now + opts.window });
    return true;
  }
  if (existing.count + cost > opts.max) {
    return false;
  }
  existing.count += cost;
  return true;
}

/** Test-only: how many buckets are held. */
export function _rateBucketCount(): number {
  return buckets.size;
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
  cost = 1,
): boolean {
  if (ip) return checkRate(scope, ip, opts, cost);
  return checkRate(
    scope,
    UNIDENTIFIED_CLIENT,
    { window: opts.window, max: opts.max * UNIDENTIFIED_BUDGET_FACTOR },
    cost,
  );
}

/** Test-only — reset the entire store. Never call in production code. */
export function _resetRateBuckets(): void {
  buckets.clear();
  callsSinceSweep = 0;
}
