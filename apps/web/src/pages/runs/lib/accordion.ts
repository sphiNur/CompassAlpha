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
 * Whether this group is the open one.
 *
 * There is deliberately NO "a lone group stays open" special case. The
 * first cut had one, reasoning that collapsing the only group leaves a
 * header and nothing else. Two problems with that:
 *
 *   - it made the toggle lie. `open` was forced true regardless of
 *     state, so the button still rendered aria-expanded=true, a ▾ glyph
 *     and a live onClick that changed nothing a user could perceive —
 *     and WAI-ARIA requires aria-expanded to reflect what activation
 *     actually does;
 *   - it was second-guessing the request. A single-store operator may
 *     well want to shut the one group to reach the send button and the
 *     summary without scrolling past forty rows, and the summary strip
 *     above the views already names the store and its total, so a
 *     collapsed lone group is not a blank screen.
 */
export function isOpen(open: string | null, key: string): boolean {
  return open === key;
}
