/**
 * Single-open accordion state for the preview card's groups.
 *
 * The user's ask, verbatim: "所有摊位是自动合上的点开才会展开，同时只有一个
 * 摊位是展开的，点开一个原本展开的会合上" — everything starts collapsed,
 * tapping opens one, tapping the open one closes it, and never two at once.
 *
 * Deliberately NOT persisted. "Collapsed by default" is the request; a
 * remembered open group would violate it on the second visit, and the
 * preview card has no runId to scope a preference to anyway.
 *
 * Pure functions rather than a hook body so they can be tested — apps/web
 * has no DOM test environment.
 */

/** Tap `key`: open it, or close it when it is already the open one. */
export function toggleOpen(open: string | null, key: string): string | null {
  return open === key ? null : key;
}

/**
 * Drop an open key that no longer exists.
 *
 * Groups are keyed by store or supplier id, and the set changes under the
 * user: reassigning a SKU's stall can empty a bucket, and the 6s poll
 * re-derives both memos. Without this the accordion would sit in a state
 * where nothing is open but no group is highlighted either.
 */
export function pruneOpen(open: string | null, keys: readonly string[]): string | null {
  if (open === null) return null;
  return keys.includes(open) ? open : null;
}

/**
 * A lone group is always open.
 *
 * Collapsing the only group leaves a header and nothing else — the user
 * would have to tap to see the one thing the screen exists to show.
 */
export function isOpen(open: string | null, key: string, groupCount: number): boolean {
  if (groupCount <= 1) return true;
  return open === key;
}
