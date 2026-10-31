/**
 * CMP-BUY-4 / CMP-INT-2 (2026-10-31): has the person typed into a sheet
 * since it opened? Feeds `Sheet`'s `hasChanges`, so Esc, a backdrop tap or
 * Telegram's back button ask before throwing the input away.
 *
 * Only the fields the person types are compared (`pick`), not the whole
 * draft: some sheets fill in derived parts (store splits) from an effect
 * right after opening, which is not an edit.
 */
import { useRef } from 'react';

type Opened = { id: string; snapshot: string } | null;

/**
 * Pure core: remembers the snapshot of the draft `identity` when first
 * seen and answers whether the current one differs. No draft → forgets.
 */
export function trackDraftChange(
  opened: { current: Opened },
  identity: string | null,
  snapshot: string | null,
): boolean {
  if (identity === null || snapshot === null) {
    opened.current = null;
    return false;
  }
  if (!opened.current || opened.current.id !== identity) {
    opened.current = { id: identity, snapshot };
  }
  return snapshot !== opened.current.snapshot;
}

export function useDraftChanged<T>(
  draft: T | null,
  identity: (draft: T) => string,
  pick: (draft: T) => unknown,
): boolean {
  const opened = useRef<Opened>(null);
  return trackDraftChange(
    opened,
    draft ? identity(draft) : null,
    draft ? JSON.stringify(pick(draft)) : null,
  );
}
