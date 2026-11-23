/**
 * Review (2026-11-23): every frame was posted to the one face worker at
 * once, with no limit, and a frame whose caller had given up still ran.
 * One member's burst made every other organisation's punches time out.
 */
import { describe, expect, test } from 'bun:test';
import { createFrameQueue, type FaceResult } from '../index';

const found: FaceResult = { found: true, feature: [1], real: 1 } as unknown as FaceResult;

/** A run whose frames finish only when the test says so. */
function controlledRun() {
  const started: Array<{ bytes: Uint8Array; finish: () => void }> = [];
  const run = (bytes: Uint8Array) =>
    new Promise<FaceResult>((resolve) => {
      started.push({ bytes, finish: () => resolve(found) });
    });
  return { run, started };
}

const frame = (n: number) => new Uint8Array([n]);
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the face frame queue', () => {
  test('one frame at a time, in order', async () => {
    const { run, started } = controlledRun();
    const q = createFrameQueue(run, 10);
    const a = q.submit(frame(1));
    const b = q.submit(frame(2));
    await tick();
    expect(started.map((s) => s.bytes[0])).toEqual([1]);
    started[0]!.finish();
    await a;
    await tick();
    expect(started.map((s) => s.bytes[0])).toEqual([1, 2]);
    started[1]!.finish();
    expect(await b).toBe(found);
  });

  test('past the cap, a frame is refused at once', async () => {
    const { run, started } = controlledRun();
    const q = createFrameQueue(run, 2);
    void q.submit(frame(1)); // running
    void q.submit(frame(2)); // waiting
    void q.submit(frame(3)); // waiting
    await tick();
    await expect(q.submit(frame(4))).rejects.toThrow('face queue full');
    expect(q.waiting()).toBe(2);
    expect(started).toHaveLength(1);
  });

  test('a waiting frame whose caller gave up is dropped, not run', async () => {
    const { run, started } = controlledRun();
    const q = createFrameQueue(run, 10);
    const first = q.submit(frame(1));
    const gaveUp = new AbortController();
    const second = q.submit(frame(2), gaveUp.signal);
    const third = q.submit(frame(3));
    gaveUp.abort();
    await expect(second).rejects.toThrow('face check cancelled');
    started[0]!.finish();
    await first;
    await tick();
    expect(started.map((s) => s.bytes[0])).toEqual([1, 3]);
    started[1]!.finish();
    await third;
  });

  test('a failed frame does not stop the ones behind it', async () => {
    let calls = 0;
    const q = createFrameQueue(async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return found;
    }, 10);
    const a = q.submit(frame(1));
    const b = q.submit(frame(2));
    await expect(a).rejects.toThrow('boom');
    expect(await b).toBe(found);
  });
});
