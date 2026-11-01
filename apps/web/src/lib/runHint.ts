/**
 * DX-PFE-3 (2026-11-01): the purchase screen asked for its run (`run.get`)
 * only after `run.list` had answered and said which run is active — one
 * extra round trip on every cold start (0.6 s on slow 4G, 2 s+ on 3G).
 * The saved query cache usually hides it, but that copy is dropped on
 * every deploy (queryPersist ties it to the build), so the first start
 * after a release paid it in full.
 *
 * The screen remembers the run it showed last, here, for its owner (user
 * + organisation, as the query cache) — a plain id, nothing else. On the
 * next start useWarmRunQueries asks for both queries at once. A stale id
 * (the run finished meanwhile) costs one unused request and nothing more:
 * the page still reads the active run from `run.list`.
 */
export const RUN_HINT_KEY = 'compass.runHint.v1';

type HintStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

interface StoredHint {
  owner: string;
  runId: string;
}

/** Remember (or with null, forget) the run on screen for `owner`. */
export function saveRunHint(storage: HintStorage | null, owner: string | null, runId: string | null): void {
  if (!storage || !owner) return;
  try {
    if (!runId) {
      storage.removeItem(RUN_HINT_KEY);
      return;
    }
    const hint: StoredHint = { owner, runId };
    storage.setItem(RUN_HINT_KEY, JSON.stringify(hint));
  } catch {
    /* storage full or blocked: the next start just waits for run.list */
  }
}

/** The run `owner` saw last, or null (none saved, someone else's, unreadable). */
export function readRunHint(storage: Pick<Storage, 'getItem'> | null, owner: string | null): string | null {
  if (!storage || !owner) return null;
  try {
    const hint = JSON.parse(storage.getItem(RUN_HINT_KEY) ?? 'null') as Partial<StoredHint> | null;
    return hint && hint.owner === owner && typeof hint.runId === 'string' && hint.runId
      ? hint.runId
      : null;
  } catch {
    return null;
  }
}

/** localStorage, or null where touching it throws (some private modes). */
export function hintStorage(): HintStorage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}
