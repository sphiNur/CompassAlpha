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

/** Storage whose keys can be listed, for pruneDrafts. */
export interface PrunableStorage extends DraftStorage {
  readonly length: number;
  key(index: number): string | null;
}

const PREFIX = 'compass.settlementDraft:';
/** Drafts older than this are dropped instead of offered back. */
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function draftStorage(): PrunableStorage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function draftKey(userId: string, recordKey: string): string {
  return `${PREFIX}${userId}:${recordKey}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string';

/** An expense line the form can show and total: text id, amount and reason. */
const isExpenseLine = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && isText(value.id) && isText(value.amount) && isText(value.reason);

/** A wage line also has its person's name and a status. */
const isWageLine = (value: unknown): boolean =>
  isExpenseLine(value) && isText(value.personName) && isText(value.status);

/**
 * The stored draft, or null when it is expired, unreadable or not the
 * form's shape. CONF-13: only the two lists' presence used to be checked,
 * so a line or a field of another type (written by another build, or
 * edited by hand) reached the form as undefined. The form's other fields
 * are all text.
 */
function parseDraft<T extends StoredDraftShape>(raw: string, now: number): T | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { at, draft } = parsed;
  if (typeof at !== 'number' || now - at > DRAFT_MAX_AGE_MS || !isRecord(draft)) return null;
  const { operatingExpenseItems, wageItems, ...fields } = draft;
  const valid =
    Array.isArray(operatingExpenseItems) &&
    operatingExpenseItems.every(isExpenseLine) &&
    Array.isArray(wageItems) &&
    wageItems.every(isWageLine) &&
    Object.values(fields).every(isText);
  return valid ? (draft as T) : null;
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
    const draft = parseDraft<T>(raw, now);
    if (!draft) storage.removeItem(key);
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

/** One record's drafts: keys `prefix` + version; the record is now at `version`. */
export interface DraftVersions {
  prefix: string;
  version: number;
}

function isEarlierVersion(key: string, { prefix, version }: DraftVersions): boolean {
  if (!key.startsWith(prefix)) return false;
  const rest = key.slice(prefix.length);
  return /^\d+$/.test(rest) && Number(rest) < version;
}

/**
 * CONF-13: only the draft being opened was ever read, so the others stayed
 * in storage for good. Drops every draft but `keep` that is expired or
 * unreadable and, given the open record's `versions`, every draft of an
 * earlier version of it: typed before someone else saved, and never
 * offered again. A later version's draft stays, in case the record shown
 * is a stale copy.
 */
export function pruneDrafts(
  storage: PrunableStorage | null,
  keep: string,
  versions: DraftVersions | null,
  now = Date.now(),
): void {
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && key !== keep && key.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      const raw = storage.getItem(key);
      const dead =
        !raw || !parseDraft(raw, now) || (versions !== null && isEarlierVersion(key, versions));
      if (dead) storage.removeItem(key);
    }
  } catch {
    // Storage blocked: nothing to tidy.
  }
}
