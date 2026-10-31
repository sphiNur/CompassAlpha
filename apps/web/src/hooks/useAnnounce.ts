import { useEffect } from 'react';
import { announce, ANNOUNCE_SETTLE_MS } from '../lib/announce';

/**
 * A11Y-12: read `message` out through Shell's status region once it has
 * stayed the same for {@link ANNOUNCE_SETTLE_MS} (so typing "beef" says
 * one result count, not four). Pass null while there is nothing to say,
 * e.g. no search or filter is active; the page's first render says
 * nothing.
 */
export function useAnnounce(message: string | null): void {
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => announce(message), ANNOUNCE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [message]);
}
