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
export type SessionLoadState = 'ok' | 'blocked' | 'staleWarning';

export function sessionLoadState(input: {
  isError: boolean;
  hasData: boolean;
  isNetworkError: boolean;
}): SessionLoadState {
  if (!input.isError) return 'ok';
  if (!input.hasData) return 'blocked';
  return input.isNetworkError ? 'ok' : 'staleWarning';
}
