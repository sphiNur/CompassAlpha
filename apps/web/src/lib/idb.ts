/**
 * Tiny promise-wrapped IndexedDB. We only need an object store for the
 * offline outbox (and later: cached run/order state for offline reads).
 *
 * Avoids `idb-keyval` to keep the bundle small and the contract explicit.
 */

const DB_NAME = 'compass';
const DB_VERSION = 1;

interface CompassDb extends IDBDatabase {}

let dbPromise: Promise<CompassDb> | null = null;

function open(): Promise<CompassDb> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB not available'));
  }
  dbPromise = new Promise<CompassDb>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('outbox')) {
        db.createObjectStore('outbox', { keyPath: 'clientSeq', autoIncrement: false });
      }
      if (!db.objectStoreNames.contains('keyval')) {
        db.createObjectStore('keyval');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(
  store: 'outbox' | 'keyval',
  mode: IDBTransactionMode,
): Promise<IDBObjectStore> {
  const db = await open();
  return db.transaction(store, mode).objectStore(store);
}

export interface OutboxEntry<P = unknown> {
  clientSeq: number;
  procedure: string;
  input: P;
  enqueuedAt: number;
  retries: number;
  /**
   * Stable idempotency key shared with the original (failed) attempt (H2).
   * When present, the replay sends it so the server dedupes a request it
   * already committed but whose response was lost. Optional: procedures
   * that aren't server-idempotent leave it unset.
   */
  idempotencyKey?: string;
}

export const outbox = {
  async add(entry: OutboxEntry): Promise<void> {
    const store = await tx('outbox', 'readwrite');
    await req(store.put(entry));
  },
  async list(): Promise<OutboxEntry[]> {
    const store = await tx('outbox', 'readonly');
    return req(store.getAll() as IDBRequest<OutboxEntry[]>);
  },
  async remove(clientSeq: number): Promise<void> {
    const store = await tx('outbox', 'readwrite');
    await req(store.delete(clientSeq));
  },
  async size(): Promise<number> {
    const store = await tx('outbox', 'readonly');
    return req(store.count());
  },
  async clear(): Promise<void> {
    const store = await tx('outbox', 'readwrite');
    await req(store.clear());
  },
};

export const keyval = {
  async get<T>(key: string): Promise<T | undefined> {
    const store = await tx('keyval', 'readonly');
    return req(store.get(key) as IDBRequest<T | undefined>);
  },
  async set<T>(key: string, value: T): Promise<void> {
    const store = await tx('keyval', 'readwrite');
    await req(store.put(value, key));
  },
  async remove(key: string): Promise<void> {
    const store = await tx('keyval', 'readwrite');
    await req(store.delete(key));
  },
};

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

let nextClientSeq: number | null = null;
export async function nextSeq(): Promise<number> {
  if (nextClientSeq === null) {
    const persisted = await keyval.get<number>('outbox:nextSeq');
    nextClientSeq = persisted ?? Date.now();
  }
  nextClientSeq += 1;
  await keyval.set('outbox:nextSeq', nextClientSeq);
  return nextClientSeq;
}
