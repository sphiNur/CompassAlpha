/**
 * Detects whether a tRPC error came from the network layer (vs. a
 * server-side domain error). The distinction matters: domain errors
 * (CONFLICT, FORBIDDEN, NOT_FOUND) are FINAL — replaying them won't
 * help. Network errors (offline, timeout, DNS, CORS preflight failure)
 * are transient — re-firing on `online` makes the mutation succeed.
 *
 * Heuristic chain:
 *   1. navigator.onLine === false  → definite network drop.
 *   2. err.cause is a TypeError    → fetch threw before getting a
 *                                    response (DNS / connection refused).
 *   3. message includes the iOS WebView's "Load failed" string.
 *   4. message includes "Failed to fetch" (Chrome / Firefox phrasing).
 *
 * Anything else is treated as a server-side error and NOT enqueued.
 */
export function isLikelyNetworkError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const e = err as { message?: string; cause?: { name?: string; message?: string } };
  if (e?.cause?.name === 'TypeError') return true;
  const msg = (e?.message ?? '').toLowerCase();
  if (msg.includes('load failed')) return true;
  if (msg.includes('failed to fetch')) return true;
  if (msg.includes('networkerror')) return true;
  return false;
}
