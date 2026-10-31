import { describe, expect, it } from 'bun:test';
import type { OutboxEntry } from '../../lib/idb';
import { isLiveEntry, sendWriteAhead } from '../useOfflineQueue';

// R2-ORD-5 (2026-10-31): a write is stored in the outbox BEFORE it is sent.
// Closing the app while the request hangs must leave it there for the next
// start; it must not be sent twice by a flush while its own request runs.
function fakeStore() {
  const rows = new Map<number, OutboxEntry>();
  let seq = 100;
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
    // The request is still out: if the app closes now, the entry is there.
    const [entry] = [...store.rows.values()];
    expect(entry?.procedure).toBe('order.adjustItem');
    expect(entry?.input).toEqual({ skuId: 's', qty: '2' });
    expect(isLiveEntry(entry!.clientSeq)).toBe(true);
    release();
    expect(await pending).toBe('ok');
    expect(store.rows.size).toBe(0);
    expect(isLiveEntry(entry!.clientSeq)).toBe(false);
  });

  it('a network failure leaves the entry queued (and no longer live)', async () => {
    const store = fakeStore();
    let queued: boolean | null = null;
    const err = await sendWriteAhead(
      'order.adjustItem',
      { qty: '1' },
      () => Promise.reject(new TypeError('Failed to fetch')),
      undefined,
      (q) => (queued = q),
      store,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(queued).toBe(true);
    const [entry] = [...store.rows.values()];
    expect(entry).toBeDefined();
    expect(isLiveEntry(entry!.clientSeq)).toBe(false);
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
    expect(await sendWriteAhead('order.adjustItem', {}, async () => 'sent', undefined, () => {}, store)).toBe(
      'sent',
    );
  });
});
