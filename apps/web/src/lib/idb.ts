/**
 * Tiny promise-wrapped IndexedDB. We only need an object store for the
 * offline outbox (and later: cached run/order state for offline reads).
 *
 * Avoids `idb-keyval` to keep the bundle small and the contract explicit.
 */

const DB_NAME = 'compass';
const DB_VERSION = 1;

type CompassDb = IDBDatabase;

let dbPromise: Promise<CompassDb> | null = null;

/**
 * How long an open may wait for another tab to let go of an older version.
 * Every write waits on the open, so a blocked one must not hang them all.
 */
const OPEN_BLOCKED_MS = 5_000;

/**
 * The shared connection, opened on first use.
 *
 * COREWEB2-04 (2026-11-09): a failed open was cached, and so was a
 * connection the browser had closed (iOS WebKit after a long time in the
 * background: "Connection to Indexed Database server lost"). Every later
 * call failed until the page was reloaded, and queued writes with it. A
 * failed open is now forgotten, and so is a connection that closes or that
 * another tab needs to upgrade: the next call opens a fresh one. An open
 * that another tab blocks fails after OPEN_BLOCKED_MS.
 */
function open(): Promise<CompassDb> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB not available'));
  }
  const opening = new Promise<CompassDb>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    let blocked: ReturnType<typeof setTimeout> | undefined;
    let gaveUp = false;
    req.onblocked = () => {
      blocked ??= setTimeout(() => {
        gaveUp = true;
        reject(new Error('IndexedDB open blocked'));
      }, OPEN_BLOCKED_MS);
    };
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('outbox')) {
        db.createObjectStore('outbox', { keyPath: 'clientSeq', autoIncrement: false });
      }
      if (!db.objectStoreNames.contains('keyval')) {
        db.createObjectStore('keyval');
      }
    };
    req.onsuccess = () => {
      clearTimeout(blocked);
      const db = req.result;
      // Unblocked after this open gave up: the next call opens its own.
      if (gaveUp) {
        db.close();
        return;
      }
      db.onclose = () => forget(opening);
      db.onversionchange = () => {
        db.close();
        forget(opening);
      };
      resolve(db);
    };
    req.onerror = () => {
      clearTimeout(blocked);
      reject(req.error);
    };
  });
  dbPromise = opening;
  opening.catch(() => forget(opening));
  return opening;
}

/** Drop the cached connection, unless a newer one replaced it already. */
function forget(connection: Promise<CompassDb>): void {
  if (dbPromise === connection) dbPromise = null;
}

async function tx(
  store: 'outbox' | 'keyval',
  mode: IDBTransactionMode,
): Promise<IDBObjectStore> {
  const connection = open();
  const db = await connection;
  try {
    return db.transaction(store, mode).objectStore(store);
  } catch {
    // The connection went away without saying so (InvalidStateError):
    // try once more on a fresh one.
    forget(connection);
    return (await open()).transaction(store, mode).objectStore(store);
  }
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
  /**
   * Who queued this write. Replay runs under whoever is signed in at the
   * time, so an entry is only replayed for its own author. Absent on
   * entries queued before this field existed.
   */
  ownerUserId?: string;
  /** When the last failed replay that counted toward the retry cap ran. */
  lastAttemptAt?: number;
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
