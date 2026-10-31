/**
 * A11Y-12 (2026-10-31): one polite status region for the whole app.
 *
 * Search and filter results changed on screen ("没有匹配的商品", "3 of 12")
 * without a word to a screen reader: the live regions on the page were all
 * empty. Shell renders a single visually hidden `role="status"` element
 * and pages call `announce()` (or the `useAnnounce` hook, which waits until
 * typing settles). One region instead of one per page, so messages never
 * talk over each other and a page needs no markup of its own.
 */
type Listener = (text: string) => void;

const listeners = new Set<Listener>();
let count = 0;

/**
 * The text the region shows for the n-th message. Every other message gets
 * a trailing no-break space, so saying the same thing twice in a row
 * ("no matches" after two searches) still changes the region's text and
 * is read again.
 */
export function announcementText(message: string, n: number): string {
  return n % 2 === 0 ? `${message}\u00a0` : message;
}

export function announce(message: string | null | undefined): void {
  const text = (message ?? '').trim();
  if (!text) return;
  count += 1;
  const shown = announcementText(text, count);
  listeners.forEach((l) => l(shown));
}

export function subscribeAnnouncements(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** How long typing must pause before a result count is read out. */
export const ANNOUNCE_SETTLE_MS = 500;
