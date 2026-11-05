/**
 * Walkthrough F18 (2026-11-05): an unsaved daily close survives the app
 * being closed.
 *
 * A cashier filling revenue, two expenses and two wages lost all of it
 * when Telegram closed the Mini App (or the phone killed it) before the
 * save. The form now keeps its unsaved state on the device, one entry per
 * user + store + date + record version, and offers it back on the next
 * open. A version in the key means a draft typed against version 2 is
 * never laid over version 3 saved meanwhile by someone else.
 *
 * Storage can be missing or throw (private modes, cleared site data); then
 * this quietly does nothing and the page works as before.
 */

export interface StoredDraftShape {
  operatingExpenseItems: unknown[];
  wageItems: unknown[];
  [field: string]: unknown;
}

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = 'compass.settlementDraft:';
/** Drafts older than this are dropped instead of offered back. */
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function draftStorage(): DraftStorage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function draftKey(userId: string, recordKey: string): string {
  return `${PREFIX}${userId}:${recordKey}`;
}

export function readDraft<T extends StoredDraftShape>(
  storage: DraftStorage | null,
  key: string,
  now = Date.now(),
): T | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at?: unknown; draft?: unknown };
    const draft = parsed?.draft as T | undefined;
    const fresh = typeof parsed?.at === 'number' && now - parsed.at <= DRAFT_MAX_AGE_MS;
    if (
      !fresh ||
      !draft ||
      typeof draft !== 'object' ||
      !Array.isArray(draft.operatingExpenseItems) ||
      !Array.isArray(draft.wageItems)
    ) {
      storage.removeItem(key);
      return null;
    }
    return draft;
  } catch {
    return null;
  }
}

export function writeDraft(
  storage: DraftStorage | null,
  key: string,
  draft: StoredDraftShape,
  now = Date.now(),
): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify({ at: now, draft }));
  } catch {
    // Quota or a blocked store: the draft just isn't kept.
  }
}

export function forgetDraft(storage: DraftStorage | null, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}
