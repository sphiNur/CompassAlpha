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

/**
 * Did the server actually reject the refresh token?
 *
 * Then the session is over and the app must go back through sign-in. A
 * dropped request, a 5xx from a restarting api, a timeout or throttling
 * says nothing about the token, and signing the user out for it throws
 * away whatever they had open on a flaky connection.
 *
 * Any other 4xx counts as a rejection, not only 401/403: the server
 * answers 400 to a token it cannot even parse. Treating that as "try
 * again later" left the client holding a token that could never work,
 * with every request failing and no way back to sign-in.
 */
export function isRefreshRejected(status: number): boolean {
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}
