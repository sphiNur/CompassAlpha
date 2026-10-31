import { beforeEach, describe, expect, it } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';

// R2-ENG-1 (2026-10-31): the offline copy of the read queries. What must
// hold: only the listed procedures are kept, a copy is only ever restored
// for the same person + organisation (+ build) and only while fresh, and
// queries React Query forgot stay in the copy until they are too old.
import {
  MAX_AGE_MS,
  cacheOwner,
  clearPersistedQueries,
  isFreshEnough,
  isRestorable,
  mergeForSave,
  procedureOf,
  restoreQueryCache,
  shouldPersistQuery,
  startQueryPersistence,
  type CacheStorage,
} from '../queryPersist';

const store = new Map<string, unknown>();
const kv: CacheStorage = {
  get: async <T,>(k: string) => store.get(k) as T | undefined,
  set: async (k, v) => void store.set(k, structuredClone(v)),
  remove: async (k) => void store.delete(k),
};

const key = (path: string, input: unknown = undefined) => [
  path.split('.'),
  { ...(input === undefined ? {} : { input }), type: 'query' },
];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  store.clear();
  await clearPersistedQueries(kv);
});

describe('which queries are kept', () => {
  it('reads the procedure out of a tRPC query key', () => {
    expect(procedureOf(key('run.get', { runId: 'r' }))).toBe('run.get');
    expect(procedureOf(['plain'])).toBeNull();
  });

  it('keeps the floor reads, not admin screens or the session check', () => {
    for (const p of [
      'order.todaySession',
      'order.todayBatches',
      'order.pendingList',
      'run.list',
      'run.get',
      'run.history',
      'settlement.get',
      'sales.list',
      'inventory.levels',
      'catalog.skus',
    ]) {
      expect(shouldPersistQuery(key(p))).toBe(true);
    }
    for (const p of ['admin.memberList', 'auth.me', 'system.recentLogs', 'platform.organizations']) {
      expect(shouldPersistQuery(key(p))).toBe(false);
    }
  });
});

describe('whose copy it is', () => {
  const now = 1_000_000_000_000;
  const saved = { owner: 'u1:o1', build: 'b1', savedAt: now - 1000 };

  it('is per user and organisation; nobody signed in keeps nothing', () => {
    expect(cacheOwner({ user: { id: 'u1' }, member: { orgId: 'o1' } })).toBe('u1:o1');
    expect(cacheOwner(null)).toBeNull();
  });

  it('is restored only for the same person, organisation and build, while fresh', () => {
    expect(isRestorable(saved, 'u1:o1', 'b1', now)).toBe(true);
    expect(isRestorable(saved, 'u2:o1', 'b1', now)).toBe(false);
    expect(isRestorable(saved, 'u1:o2', 'b1', now)).toBe(false);
    expect(isRestorable(saved, 'u1:o1', 'b2', now)).toBe(false);
    expect(isRestorable(saved, null, 'b1', now)).toBe(false);
    expect(isRestorable({ ...saved, savedAt: now - MAX_AGE_MS - 1 }, 'u1:o1', 'b1', now)).toBe(false);
  });
});

describe('isFreshEnough', () => {
  it('keeps "today" answers only on the day they were loaded', () => {
    const now = new Date(2026, 9, 31, 7, 0).getTime();
    const lastNight = new Date(2026, 9, 30, 22, 0).getTime();
    const thisMorning = new Date(2026, 9, 31, 6, 30).getTime();
    expect(isFreshEnough(key('order.todaySession'), lastNight, now)).toBe(false);
    expect(isFreshEnough(key('order.todaySession'), thisMorning, now)).toBe(true);
    expect(isFreshEnough(key('sales.list'), lastNight, now)).toBe(false);
    // A run or the history keeps its date inside the data: last night's copy is fine.
    expect(isFreshEnough(key('run.get'), lastNight, now)).toBe(true);
    expect(isFreshEnough(key('run.get'), now - MAX_AGE_MS - 1, now)).toBe(false);
  });
});

describe('mergeForSave', () => {
  it('keeps forgotten queries until they are too old; memory wins', () => {
    const now = 10 * MAX_AGE_MS;
    const q = (hash: string, at: number, data: unknown) =>
      ({ queryHash: hash, queryKey: [hash], state: { dataUpdatedAt: at, data } }) as never;
    const prev = new Map([
      ['a', q('a', now - 1000, 'old a')],
      ['b', q('b', now - 2000, 'b')],
      ['c', q('c', now - MAX_AGE_MS - 1, 'too old')],
    ]);
    const out = mergeForSave(prev, [q('a', now, 'new a')], now);
    expect([...out.keys()].sort()).toEqual(['a', 'b']);
    expect((out.get('a') as { state: { data: unknown } }).state.data).toBe('new a');
  });
});

describe('save and restore', () => {
  it('saves listed queries and restores them for the same owner only', async () => {
    let owner: string | null = 'u1:o1';
    const a = new QueryClient();
    const stop = startQueryPersistence(a, () => owner, kv);
    a.setQueryData(key('run.list'), [{ id: 'r1' }]);
    a.setQueryData(key('admin.memberList'), ['secret']);
    await wait(1_100);
    stop();

    const same = new QueryClient();
    await restoreQueryCache(same, 'u1:o1', kv);
    expect(same.getQueryData(key('run.list'))).toEqual([{ id: 'r1' }]);
    expect(same.getQueryData(key('admin.memberList'))).toBeUndefined();
    // Restored data keeps its load time, so it is refetched when online.
    expect(same.getQueryState(key('run.list'))?.dataUpdatedAt).toBeGreaterThan(0);

    const other = new QueryClient();
    await restoreQueryCache(other, 'u2:o1', kv);
    expect(other.getQueryData(key('run.list'))).toBeUndefined();
    // A copy that is not theirs is deleted, not only skipped.
    expect(store.size).toBe(0);
    owner = null;
  });

  it('never carries one owner’s rows into another owner’s copy', async () => {
    let owner: string | null = 'u1:o1';
    const qc = new QueryClient();
    const stop = startQueryPersistence(qc, () => owner, kv);
    qc.setQueryData(key('run.list'), ['org1 run']);
    await wait(1_100);
    // Organisation switch: the app clears the cache, then loads org 2.
    qc.clear();
    owner = 'u1:o2';
    qc.setQueryData(key('order.pendingList'), ['org2 order']);
    await wait(1_100);
    stop();

    const restored = new QueryClient();
    await restoreQueryCache(restored, 'u1:o2', kv);
    expect(restored.getQueryData(key('order.pendingList'))).toEqual(['org2 order']);
    expect(restored.getQueryData(key('run.list'))).toBeUndefined();
  });

  it('signing out deletes the copy', async () => {
    const qc = new QueryClient();
    const stop = startQueryPersistence(qc, () => 'u1:o1', kv);
    qc.setQueryData(key('run.list'), ['x']);
    await wait(1_100);
    stop();
    expect(store.size).toBe(1);
    await clearPersistedQueries(kv);
    expect(store.size).toBe(0);
  });
});
