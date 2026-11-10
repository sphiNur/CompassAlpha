/**
 * Outbox ids (review COREWEB2-01, 2026-11-09). Two writes queued at the
 * same moment used to get the same id, and the second replaced the first
 * in the outbox after the screen had said "saved offline".
 */
import { describe, expect, test } from 'bun:test';
import { createSeq } from '../idb';

/** A store that answers after a random few milliseconds, like IndexedDB. */
function slowStore(start?: number) {
  let saved = start;
  const later = <T>(v: T) =>
    new Promise<T>((resolve) => setTimeout(() => resolve(v), Math.random() * 5));
  return {
    load: () => later(saved),
    save: async (n: number) => {
      await later(undefined);
      saved = Math.max(saved ?? 0, n);
    },
    saved: () => saved,
  };
}

describe('outbox ids', () => {
  test('writes queued together each get their own id', async () => {
    const store = slowStore(100);
    const next = createSeq(store);
    const ids = await Promise.all(Array.from({ length: 20 }, () => next()));
    expect(new Set(ids).size).toBe(20);
    expect([...ids].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => 101 + i));
    expect(store.saved()).toBe(120);
  });

  test('a fresh install starts from the clock, and a reload carries on', async () => {
    const store = slowStore();
    const first = createSeq(store, () => 5_000);
    expect(await first()).toBe(5_001);
    const afterReload = createSeq(store, () => 1);
    expect(await afterReload()).toBe(5_002);
  });

  test('a failed first read is tried again on the next write', async () => {
    let fail = true;
    const next = createSeq({
      load: async () => {
        if (fail) throw new Error('blocked');
        return 7;
      },
      save: async () => {},
    });
    await expect(next()).rejects.toThrow('blocked');
    fail = false;
    expect(await next()).toBe(8);
  });
});
