/**
 * Review MWD-04 (modern-web-guidance: schedule-tasks-by-priority): without
 * requestIdleCallback (iOS) the chunk prefetch ran on setTimeout(0), all
 * chunks at once. It now waits for `load` plus AFTER_LOAD_MS, and starts
 * one chunk at a time.
 */
import { describe, expect, it } from 'bun:test';
import { AFTER_LOAD_MS, prefetchInTurn, type IdleHost } from '../shell/idlePrefetch';

function fakeHost(opts: { idle?: boolean; ready?: DocumentReadyState } = {}) {
  let ready: DocumentReadyState = opts.ready ?? 'loading';
  const timers: Array<{ cb: () => void; ms: number; id: number }> = [];
  const idle: Array<{ cb: () => void; id: number }> = [];
  const load = new Set<() => void>();
  let next = 1;
  const host: IdleHost = {
    setTimeout: (cb, ms) => {
      const id = next++;
      timers.push({ cb, ms, id });
      return id;
    },
    clearTimeout: (id) => {
      const i = timers.findIndex((t) => t.id === (id as unknown as number));
      if (i >= 0) timers.splice(i, 1);
    },
    addEventListener: (_t, cb) => void load.add(cb),
    removeEventListener: (_t, cb) => void load.delete(cb),
    readyState: () => ready,
  };
  if (opts.idle) {
    host.requestIdleCallback = (cb) => {
      const id = next++;
      idle.push({ cb, id });
      return id;
    };
    host.cancelIdleCallback = (id) => {
      const i = idle.findIndex((t) => t.id === id);
      if (i >= 0) idle.splice(i, 1);
    };
  }
  return {
    host,
    timers,
    idle,
    fireLoad() {
      ready = 'complete';
      for (const cb of [...load]) cb();
      load.clear();
    },
    runTimers() {
      for (const t of timers.splice(0)) t.cb();
    },
    runIdle() {
      for (const t of idle.splice(0)) t.cb();
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function tasks(n: number) {
  const started: number[] = [];
  const done: Array<() => void> = [];
  const list = Array.from({ length: n }, (_, i) => () => {
    started.push(i);
    return new Promise<void>((resolve) => done.push(resolve));
  });
  return { started, done, list };
}

describe('prefetchInTurn without requestIdleCallback', () => {
  it('waits for load and AFTER_LOAD_MS, then starts one chunk at a time', async () => {
    const f = fakeHost();
    const t = tasks(3);
    prefetchInTurn(f.host, t.list);
    expect(f.timers).toHaveLength(0); // not before load
    f.fireLoad();
    expect(f.timers.map((x) => x.ms)).toEqual([AFTER_LOAD_MS]);
    expect(t.started).toEqual([]);
    f.runTimers();
    expect(t.started).toEqual([0]);
    f.runTimers();
    expect(t.started).toEqual([0]); // the next waits for the first to settle
    t.done[0]!();
    await flush();
    f.runTimers();
    expect(t.started).toEqual([0, 1]);
    t.done[1]!();
    await flush();
    f.runTimers();
    expect(t.started).toEqual([0, 1, 2]);
  });

  it('does not wait for a load that already happened', () => {
    const f = fakeHost({ ready: 'complete' });
    const t = tasks(1);
    prefetchInTurn(f.host, t.list);
    expect(f.timers.map((x) => x.ms)).toEqual([AFTER_LOAD_MS]);
  });

  it('a failed chunk does not stop the next one', async () => {
    const f = fakeHost({ ready: 'complete' });
    const started: string[] = [];
    prefetchInTurn(f.host, [
      () => (started.push('a'), Promise.reject(new Error('offline'))),
      () => (started.push('b'), Promise.resolve()),
    ]);
    f.runTimers();
    await flush();
    f.runTimers();
    expect(started).toEqual(['a', 'b']);
  });

  it('cancel stops what has not started', async () => {
    const f = fakeHost();
    const t = tasks(2);
    const cancel = prefetchInTurn(f.host, t.list);
    cancel();
    f.fireLoad();
    f.runTimers();
    expect(t.started).toEqual([]);
  });
});

describe('prefetchInTurn with requestIdleCallback', () => {
  it('uses it for each chunk, one at a time', async () => {
    const f = fakeHost({ idle: true });
    const t = tasks(2);
    prefetchInTurn(f.host, t.list);
    expect(f.timers).toHaveLength(0);
    f.runIdle();
    expect(t.started).toEqual([0]);
    t.done[0]!();
    await flush();
    f.runIdle();
    expect(t.started).toEqual([0, 1]);
  });
});
