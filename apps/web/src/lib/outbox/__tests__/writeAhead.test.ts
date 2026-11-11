import { afterEach, describe, expect, it } from 'bun:test';
import type { OutboxEntry } from '../../idb';
import { useAuthStore } from '../../../stores/authStore';
import { testSession } from '../../../__tests__/fixtures/session';
import { isLiveEntry, sendWriteAhead } from '../engine';

const initialAuth = useAuthStore.getState();
afterEach(() => {
  useAuthStore.setState(initialAuth, true);
});

// R2-ORD-5 (2026-10-31): a write is stored in the outbox BEFORE it is sent.
// Closing the app while the request hangs must leave it there for the next
// start; it must not be sent twice by a flush while its own request runs.
// Each store numbers its entries from a range of its own: the engine's
// set of entries being sent is module state, so a test that failed with
// one still out must not make the next test's entry look live.
let nextRange = 100;
function fakeStore() {
  const rows = new Map<number, OutboxEntry>();
  let seq = nextRange;
  nextRange += 1000;
  return {
    rows,
    add: async (e: OutboxEntry) => void rows.set(e.clientSeq, e),
    remove: async (s: number) => void rows.delete(s),
    nextSeq: async () => ++seq,
  };
}

describe('sendWriteAhead', () => {
  it('stores the write first, flush leaves it alone while it is sent, success removes it', async () => {
    const store = fakeStore();
    let release!: () => void;
    const pending = sendWriteAhead(
      'order.adjustItem',
      { skuId: 's', qty: '2' },
      () => new Promise<string>((r) => (release = () => r('ok'))),
      undefined,
      () => {},
      store,
    );
    await new Promise((r) => setTimeout(r, 0));
    const [entry] = [...store.rows.values()];
    try {
      // The request is still out: if the app closes now, the entry is there.
      expect(entry?.procedure).toBe('order.adjustItem');
      expect(entry?.input).toEqual({ skuId: 's', qty: '2' });
      expect(isLiveEntry(entry!.clientSeq)).toBe(true);
    } finally {
      // Settle the request even when an assertion failed, so the entry
      // leaves the engine's live set (TEST3-07).
      release();
    }
    expect(await pending).toBe('ok');
    expect(store.rows.size).toBe(0);
    expect(isLiveEntry(entry!.clientSeq)).toBe(false);
  });

  it('a network failure leaves the entry queued (and no longer live)', async () => {
    const store = fakeStore();
    const queued: boolean[] = [];
    const err = await sendWriteAhead(
      'order.adjustItem',
      { qty: '1' },
      () => Promise.reject(new TypeError('Failed to fetch')),
      undefined,
      (q) => queued.push(q),
      store,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(queued).toEqual([true]);
    const [entry] = [...store.rows.values()];
    expect(entry).toBeDefined();
    expect(isLiveEntry(entry!.clientSeq)).toBe(false);
  });

  it('a refused session leaves the entry queued too, as the replay does (COREWEB2-02)', async () => {
    const store = fakeStore();
    const queued: boolean[] = [];
    const signedOut = Object.assign(new Error('auth.errors.required'), {
      data: { code: 'UNAUTHORIZED' },
    });
    const err = await sendWriteAhead(
      'order.adjustItem',
      { qty: '3' },
      () => Promise.reject(signedOut),
      undefined,
      (q) => queued.push(q),
      store,
    ).catch((e) => e);
    expect(err).toBe(signedOut);
    expect(queued).toEqual([true]);
    expect([...store.rows.values()].map((e) => e.input)).toEqual([{ qty: '3' }]);
  });

  it('a server rejection removes the entry and is rethrown', async () => {
    const store = fakeStore();
    const rejection = Object.assign(new Error('order.errors.cannotDraft'), {
      data: { code: 'BAD_REQUEST' },
    });
    const err = await sendWriteAhead(
      'order.adjustItem',
      { qty: '1' },
      () => Promise.reject(rejection),
      undefined,
      () => {},
      store,
    ).catch((e) => e);
    expect(err).toBe(rejection);
    expect(store.rows.size).toBe(0);
  });

  it('keeps the idempotency key on the stored entry for a replay', async () => {
    const store = fakeStore();
    await sendWriteAhead(
      'run.purchaseItem',
      {},
      () => Promise.reject(new TypeError('Load failed')),
      'key-1',
      () => {},
      store,
    ).catch(() => {});
    expect([...store.rows.values()][0]?.idempotencyKey).toBe('key-1');
  });

  it('still sends when IndexedDB is unavailable', async () => {
    const store = {
      add: async () => Promise.reject(new Error('IndexedDB not available')),
      remove: async () => {},
      nextSeq: async () => 1,
    };
    expect(
      await sendWriteAhead(
        'order.adjustItem',
        {},
        async () => 'sent',
        undefined,
        () => {},
        store,
      ),
    ).toBe('sent');
  });
});

describe('who a queued write belongs to', () => {
  // COREWEB2-03: the replay only sends a write for the person AND the
  // organisation it was made in, so both are stored with it.
  it('records the signed-in person and their organisation', async () => {
    const session = testSession();
    useAuthStore.setState({ session });
    const store = fakeStore();
    const err = await sendWriteAhead(
      'run.purchaseItem',
      { skuId: 's' },
      () => Promise.reject(new TypeError('Failed to fetch')),
      undefined,
      () => {},
      store,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    const [entry] = [...store.rows.values()];
    expect(entry?.ownerUserId).toBe(session.user.id);
    expect(entry?.ownerOrgId).toBe(session.member.orgId);
  });
});
