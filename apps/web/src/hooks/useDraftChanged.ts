/**
 * CMP-BUY-4 / CMP-INT-2 (2026-10-31): has the person typed into a sheet
 * since it opened? Feeds `Sheet`'s `hasChanges`, so Esc, a backdrop tap or
 * Telegram's back button ask before throwing the input away.
 *
 * Only the fields the person types are compared (`pick`), not the whole
 * draft: some sheets fill in derived parts (store splits) from an effect
 * right after opening, which is not an edit.
 *
 * Review ADM2-11 (2026-11-11): the snapshot taken at opening is state,
 * set while rendering (React's way to keep information from earlier
 * renders). It was a ref written during render, which StrictMode and
 * concurrent rendering may run twice or throw away. The catalog editors
 * now use this hook too (useEditorSheet) instead of a copy of their own.
 */
import { useState } from 'react';

/** The draft a sheet opened with: its identity and its typed fields as JSON. */
export type OpenedDraft = { id: string; snapshot: string } | null;

/**
 * Pure core. Keeps the snapshot taken when the draft `identity` was first
 * seen; another identity starts over from its own, and no draft forgets.
 * `changed`: the current snapshot differs from the kept one.
 */
export function stepDraftChange(
  opened: OpenedDraft,
  identity: string | null,
  snapshot: string | null,
): { opened: OpenedDraft; changed: boolean } {
  if (identity === null || snapshot === null) return { opened: null, changed: false };
  const kept = opened?.id === identity ? opened : { id: identity, snapshot };
  return { opened: kept, changed: snapshot !== kept.snapshot };
}

export function useDraftChanged<T>(
  draft: T | null,
  identity: (draft: T) => string,
  pick: (draft: T) => unknown,
): boolean {
  const [opened, setOpened] = useState<OpenedDraft>(null);
  const step = stepDraftChange(
    opened,
    draft ? identity(draft) : null,
    draft ? JSON.stringify(pick(draft)) : null,
  );
  // Only when a sheet opens, opens on another draft or closes; the render
  // this causes keeps the stored snapshot, so it stops there.
  if (step.opened !== opened) setOpened(step.opened);
  return step.changed;
}

/**
 * Props for a sheet that edits `draft` and closes by setting it to null.
 * It is open while there is a draft. Esc, a backdrop tap or Telegram's back
 * button ask before dropping typed changes, and it stays open while `busy`
 * (saving; atlas CAT-18: a catalog editor could close mid-save). Review
 * ADM2-11 (2026-11-11): the catalog's five editors each did this through
 * useEditorClose, with a "discard?" of its own.
 */
export function useEditorSheet<T>(
  draft: T | null,
  setDraft: (draft: null) => void,
  identity: (draft: T) => string,
  busy: boolean,
): { open: boolean; onOpenChange: (open: boolean) => void; hasChanges: boolean } {
  const changed = useDraftChanged(draft, identity, (d) => d);
  return {
    open: draft !== null,
    onOpenChange: (open) => {
      if (!open && !busy) setDraft(null);
    },
    hasChanges: changed && !busy,
  };
}
