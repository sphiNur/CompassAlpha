/**
 * 2026-10-21 FE-01 (T01 / F2-24): how OrderPage treats the result of
 * `order.todaySession`.
 *
 * An errored query with no data used to render as "no session today" —
 * an empty, editable catalog — so a staff member who had already
 * submitted could order again (the first tap lazily creates a new
 * draft). That case now blocks the page behind an error + Retry.
 *
 * A failed BACKGROUND refetch keeps the cached data on screen: blanking
 * a working page (or an offline one, whose edits the outbox replays)
 * would be worse than slightly stale data. It gets at most a small
 * warning, and none for network errors — that is the offline path the
 * queue already handles and re-syncs on reconnect.
 *
 * `hasData` is `data !== undefined`: `null` is a successful "no session".
 */
export type SessionLoadState = 'ok' | 'blocked' | 'staleWarning' | 'offline';

/**
 * R2-ENG-1 (2026-10-31): offline with no saved copy the query does not
 * fail, it waits (`fetchStatus: 'paused'`) — and fell through to "no
 * session", the same editable empty catalog FE-01 closed for errors.
 * That is 'offline': blocked, but it loads by itself once back online.
 */
export function sessionLoadState(input: {
  isError: boolean;
  hasData: boolean;
  isNetworkError: boolean;
  waitingOffline?: boolean;
}): SessionLoadState {
  if (!input.hasData && input.waitingOffline) return 'offline';
  if (!input.isError) return 'ok';
  if (!input.hasData) return 'blocked';
  return input.isNetworkError ? 'ok' : 'staleWarning';
}
