/**
 * Which client address the rate limiter may trust (AUTH-6 / N10,
 * 2026-10-30).
 *
 * Production traffic arrives browser → Cloudflare Worker (workers.dev)
 * → quick tunnel → nginx → API. Before this, the limiter keyed on
 * `cf-connecting-ip ?? x-forwarded-for`:
 *   - `x-forwarded-for` is whatever the client sent; the Worker forwards
 *     request headers as they are. A new value per request was a new
 *     bucket, so the login limit never fired.
 *   - `cf-connecting-ip` on the tunnel hop is set by Cloudflare for the
 *     Worker's own subrequest, so it names the Worker, not the person,
 *     and anyone reaching the origin directly can write it themselves.
 *   - no header at all meant no limit.
 *
 * The Worker is the one hop that sees the real address (Cloudflare sets
 * `cf-connecting-ip` on the request reaching it and a client cannot
 * override that). With the shared secret `CLIENT_IP_PROXY_KEY`
 * configured on both sides, the Worker passes that address in
 * `x-compass-client-ip` alongside `x-compass-proxy-key`, and only a
 * request carrying the right key gets its address trusted.
 *
 * Until the secret is configured the old `cf-connecting-ip` is still
 * used (never `x-forwarded-for`), so deploying the API before the Worker
 * changes nothing for real users. A request with no trusted address goes
 * into one shared bucket instead of escaping the limit.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const CLIENT_IP_HEADER = 'x-compass-client-ip';
export const PROXY_KEY_HEADER = 'x-compass-proxy-key';

type HeaderReader = (name: string) => string | undefined;

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function proxyKeyMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  return timingSafeEqual(digest(provided), digest(expected));
}

/** One literal IPv4/IPv6 address, or null for anything else. */
function asIp(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value || isIP(value) === 0) return null;
  return value.toLowerCase();
}

/**
 * The client address to rate-limit on, or null when no address can be
 * trusted (callers then use one shared bucket).
 */
export function trustedClientIp(header: HeaderReader, proxyKey: string | undefined): string | null {
  if (proxyKey) {
    if (!proxyKeyMatches(header(PROXY_KEY_HEADER), proxyKey)) return null;
    return asIp(header(CLIENT_IP_HEADER));
  }
  return asIp(header('cf-connecting-ip'));
}
