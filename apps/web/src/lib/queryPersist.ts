/**
 * Offline reads (R2-ENG-1 / R2-SHL-2, 2026-10-31).
 *
 * sw.js brings the shell back on an offline reload, but React Query's
 * cache lived only in memory: the buyer at the market who reloaded with
 * no signal saw spinners, "network error" and fake empty totals under a
 * banner promising "the last loaded content". This keeps a copy of the
 * read queries a person needs on the floor (today's order and batches,
 * the run and its purchase list, approvals, history, the day's
 * settlement and sales, stock) in IndexedDB and puts it back on start.
 *
 * Rules:
 *   - only the procedures in PERSISTED_QUERIES, only successful data,
 *     nothing older than MAX_AGE_MS;
 *   - tagged with its owner (user + organisation) and the running build;
 *     a copy that belongs to someone else, another organisation or
 *     another deploy is thrown away unread, and signing out or switching
 *     organisation deletes it;
 *   - writes never come from here — the outbox does that.
 */
import { dehydrate, hydrate, type DehydratedState, type QueryClient } from '@tanstack/react-query';

type DehydratedQuery = DehydratedState['queries'][number];

/** Where the copy lives; the IndexedDB keyval store in the app, a map in tests. */
export interface CacheStorage {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}
import { keyval } from './idb';

const STORAGE_KEY = 'queryCache:v1';
/** A copy older than this is not shown: a day's work, plus a night. */
export const MAX_AGE_MS = 36 * 60 * 60 * 1000;
/** Coalesce a burst of query updates into one IndexedDB write. */
const SAVE_DELAY_MS = 1_000;
/**
 * A refetch that returned the same data (TanStack keeps the old reference)
 * does not need a new IndexedDB write — except now and then, so the saved
 * load time does not fall behind MAX_AGE_MS / the "today" rule while a
 * screen keeps polling unchanged data.
 */
export const RESAVE_UNCHANGED_MS = 10 * 60 * 1000;

/** Does this successful fetch need a save? P-4 (2026-10-31). */
export function needsSave(
  prev: { data: unknown; at: number } | undefined,
  data: unknown,
  at: number,
): boolean {
  return !prev || prev.data !== data || at - prev.at >= RESAVE_UNCHANGED_MS;
}

/**
 * tRPC procedures whose last answer is worth keeping for an offline
 * start. Lookups the pages need to draw those answers (products, stores,
 * categories, suppliers, dishes) are included; admin screens are not.
 */
export const PERSISTED_QUERIES: ReadonlySet<string> = new Set([
  'catalog.skus',
  'catalog.stores',
  'catalog.categories',
  'catalog.suppliers',
  'system.appConfig',
  'order.todaySession',
  'order.todayBatches',
  'order.pendingList',
  'order.sessionDetail',
  'order.extrasSuggestions',
  'run.list',
  'run.get',
  'run.history',
  'run.historyDetail',
  'run.expenseTemplates',
  'settlement.businessDate',
  'settlement.get',
  'settlement.recent',
  'settlement.wageRoster',
  'sales.list',
  'dishes.list',
  'inventory.levels',
  'inventory.recentMovements',
]);

/**
 * Answers that mean "today" on the server (today's order and batches, the
 * business date, today's sales). A copy from an earlier day would show
 * yesterday's batch as today's — and an edit made on it would queue for
 * the wrong day — so these are restored only on the day they were loaded
 * (device time; staff phones run in the organisation's time zone).
 */
export const TODAY_QUERIES: ReadonlySet<string> = new Set([
  'order.todaySession',
  'order.todayBatches',
  'order.extrasSuggestions',
  'settlement.businessDate',
  'sales.list',
]);

/** Is a copy of `queryKey` loaded at `loadedAt` still fit to show at `now`? */
export function isFreshEnough(queryKey: readonly unknown[], loadedAt: number, now: number): boolean {
  if (now - loadedAt > MAX_AGE_MS) return false;
  const proc = procedureOf(queryKey);
  if (proc === null || !TODAY_QUERIES.has(proc)) return true;
  const a = new Date(loadedAt);
  const b = new Date(now);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** `[['run','get'], { input, type }]` → 'run.get'. */
export function procedureOf(queryKey: readonly unknown[]): string | null {
  const path = queryKey[0];
  if (!Array.isArray(path) || !path.every((p) => typeof p === 'string')) return null;
  return path.join('.');
}

export function shouldPersistQuery(queryKey: readonly unknown[]): boolean {
  const proc = procedureOf(queryKey);
  return proc !== null && PERSISTED_QUERIES.has(proc);
}

/** Whose cache this is. Null while nobody is signed in: nothing is kept. */
export function cacheOwner(
  session: { user: { id: string }; member: { orgId: string } } | null | undefined,
): string | null {
  if (!session) return null;
  return `${session.user.id}:${session.member.orgId}`;
}

/**
 * What was saved last, by query hash, and for whom. A query React Query
 * dropped from memory (gcTime, five minutes after its page closed) stays
 * in the saved copy until it is too old: the history opened this morning
 * is still there for an offline reload this afternoon.
 */
let remembered = new Map<string, DehydratedQuery>();
let rememberedOwner: string | null = null;

/** Merge what is in memory now over what was saved before, dropping the old. */
export function mergeForSave(
  previous: ReadonlyMap<string, DehydratedQuery>,
  current: readonly DehydratedQuery[],
  now: number,
): Map<string, DehydratedQuery> {
  const out = new Map<string, DehydratedQuery>();
  for (const [hash, q] of previous) {
    if (isFreshEnough(q.queryKey, q.state.dataUpdatedAt, now)) out.set(hash, q);
  }
  for (const q of current) out.set(q.queryHash, q);
  return out;
}

export interface PersistedCache {
  owner: string;
  build: string;
  savedAt: number;
  state: DehydratedState;
}

/** May this saved copy be shown to `owner` running `build` right now? */
export function isRestorable(
  saved: Pick<PersistedCache, 'owner' | 'build' | 'savedAt'> | undefined | null,
  owner: string | null,
  build: string,
  now: number,
): boolean {
  if (!saved || !owner) return false;
  if (saved.owner !== owner || saved.build !== build) return false;
  return now - saved.savedAt <= MAX_AGE_MS;
}

/** The running deploy (index.html's build meta); 'dev' without one. */
export function runningBuild(): string {
  if (typeof document === 'undefined') return 'dev';
  const v = (document.querySelector('meta[name="compass-build"]') as HTMLMetaElement | null)?.content;
  return v && v !== '%VITE_BUILD_SHA%' ? v : 'dev';
}

/**
 * Put back the saved copy for `owner`, if there is a usable one. Data
 * keeps its original `dataUpdatedAt`, so it is stale at once: online it
 * is refetched on mount, offline it stays on screen with its age shown.
 */
export async function restoreQueryCache(
  queryClient: QueryClient,
  owner: string | null,
  storage: CacheStorage = keyval,
): Promise<void> {
  if (!owner) return;
  let saved: PersistedCache | undefined;
  try {
    saved = await storage.get<PersistedCache>(STORAGE_KEY);
  } catch {
    return; // IndexedDB unavailable: start empty, as before
  }
  if (!saved) return;
  const now = Date.now();
  if (!isRestorable(saved, owner, runningBuild(), now)) {
    void clearPersistedQueries(storage);
    return;
  }
  const queries = saved.state.queries.filter(
    (q) => shouldPersistQuery(q.queryKey) && isFreshEnough(q.queryKey, q.state.dataUpdatedAt, now),
  );
  hydrate(queryClient, { mutations: [], queries });
  remembered = new Map(queries.map((q) => [q.queryHash, q]));
  rememberedOwner = owner;
}

export async function clearPersistedQueries(storage: CacheStorage = keyval): Promise<void> {
  remembered = new Map();
  rememberedOwner = null;
  try {
    await storage.remove(STORAGE_KEY);
  } catch {
    /* IndexedDB unavailable: nothing was saved */
  }
}

/**
 * Keep saving the persisted queries as they change, for whoever
 * `getOwner` names at the time. Returns the unsubscribe.
 */
export function startQueryPersistence(
  queryClient: QueryClient,
  getOwner: () => string | null,
  storage: CacheStorage = keyval,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    timer = null;
    const owner = getOwner();
    if (!owner) return;
    const now = Date.now();
    const current = dehydrate(queryClient, {
      shouldDehydrateMutation: () => false,
      shouldDehydrateQuery: (q) =>
        q.state.status === 'success' &&
        q.state.data !== undefined &&
        now - q.state.dataUpdatedAt <= MAX_AGE_MS &&
        shouldPersistQuery(q.queryKey),
    });
    // Another person or organisation: never carry the previous one's rows.
    if (rememberedOwner !== owner) remembered = new Map();
    remembered = mergeForSave(remembered, current.queries, now);
    rememberedOwner = owner;
    const state: DehydratedState = { mutations: [], queries: [...remembered.values()] };
    const entry: PersistedCache = { owner, build: runningBuild(), savedAt: now, state };
    void storage.set(STORAGE_KEY, entry).catch(() => {
      /* quota or IndexedDB unavailable: offline reads just won't have it */
    });
  };
  const schedule = () => {
    if (timer === null) timer = setTimeout(save, SAVE_DELAY_MS);
  };
  // Per query: the data last scheduled for saving, and when it loaded.
  // A 6 s poll returning the same answer used to rewrite the whole copy
  // every time.
  const scheduled = new Map<string, { data: unknown; at: number }>();
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event.type === 'removed') {
      scheduled.delete(event.query.queryHash);
      return;
    }
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    if (!shouldPersistQuery(event.query.queryKey)) return;
    const { data, dataUpdatedAt } = event.query.state;
    if (!needsSave(scheduled.get(event.query.queryHash), data, dataUpdatedAt)) return;
    scheduled.set(event.query.queryHash, { data, at: dataUpdatedAt });
    schedule();
  });
  // Closing the app inside the coalescing window must not lose the copy.
  const onHide = () => {
    if (timer !== null) {
      clearTimeout(timer);
      save();
    }
  };
  const hasWindow = typeof window !== 'undefined';
  if (hasWindow) window.addEventListener('pagehide', onHide);
  return () => {
    unsubscribe();
    if (hasWindow) window.removeEventListener('pagehide', onHide);
    if (timer !== null) clearTimeout(timer);
  };
}
