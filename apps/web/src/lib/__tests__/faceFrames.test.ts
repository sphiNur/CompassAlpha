/**
 * Review MWD-05 (modern-web-guidance: performance): the face tracker's
 * worker gets one frame at a time, its readings are handed out once, and
 * the page falls back to its own tracker where the worker cannot run.
 */
import { describe, expect, test } from 'bun:test';
import { createFramePump, workerSupported } from '../faceFrames';
import type { FaceReading } from '../faceMesh';

const reading = (count: number): FaceReading => ({
  count,
  yaw: null,
  pitch: null,
  size: null,
  cx: null,
  cy: null,
  blink: null,
  jaw: null,
});

/** A pump on a hand-driven clock; frames are names. */
function rig(opts: { staleGapMs?: number; lostMs?: number; maxErrors?: number } = {}) {
  let t = 0;
  const sent: { frame: string; at: number; id: number }[] = [];
  const dropped: string[] = [];
  const broken: string[] = [];
  let n = 0;
  let captures = 0;
  const pump = createFramePump<string>({
    now: () => t,
    send: (frame, at, id) => sent.push({ frame, at, id }),
    drop: (frame) => dropped.push(frame),
    broken: (why) => broken.push(why),
    ...opts,
  });
  const capture = () => {
    captures += 1;
    return Promise.resolve(`f${++n}`);
  };
  return {
    pump,
    sent,
    dropped,
    broken,
    get captures() {
      return captures;
    },
    at(ms: number) {
      t = ms;
    },
    /** Lets the capture promises settle. */
    flush: () => Promise.resolve().then(() => {}),
    poll: () => pump.poll(capture),
  };
}

describe('frame pump', () => {
  test('one frame in flight: polls while the worker is busy take no new frame', async () => {
    const r = rig();
    expect(r.poll()).toBeNull();
    await r.flush();
    expect(r.sent).toEqual([{ frame: 'f1', at: 0, id: 1 }]);
    r.at(50);
    expect(r.poll()).toBeNull();
    r.at(100);
    expect(r.poll()).toBeNull();
    expect(r.captures).toBe(1);
    expect(r.pump.busy).toBe(true);
  });

  test('a reading is handed out once, with its frame and the time the frame was taken', async () => {
    const r = rig();
    r.at(10);
    r.poll();
    await r.flush();
    r.pump.deliver(1, reading(1), 'f1');
    r.at(60);
    expect(r.poll()).toEqual({ reading: reading(1), frame: 'f1', at: 10 });
    // That poll sent the next frame; nothing new until it comes back.
    await r.flush();
    expect(r.sent.map((s) => s.frame)).toEqual(['f1', 'f2']);
    r.at(110);
    expect(r.poll()).toBeNull();
    // The handed-out frame lives until the next poll, then is freed.
    expect(r.dropped).toEqual(['f1']);
  });

  test('a reading that waited through a pause (page hidden) is dropped as stale', async () => {
    const r = rig({ staleGapMs: 400 });
    r.poll();
    await r.flush();
    r.pump.deliver(1, reading(1), 'f1');
    r.at(5_000);
    expect(r.poll()).toBeNull();
    expect(r.dropped).toEqual(['f1']);
    // And a new frame went out at once.
    await r.flush();
    expect(r.sent.at(-1)).toMatchObject({ frame: 'f2', at: 5_000 });
  });

  test('a frame that never comes back gives the worker up; a pause does not count', async () => {
    const r = rig({ staleGapMs: 400, lostMs: 1_000 });
    r.poll();
    await r.flush();
    // Hidden for 10 s with the frame out: its clock restarts on return.
    r.at(10_000);
    r.poll();
    expect(r.broken).toEqual([]);
    for (let t = 10_100; t <= 11_000; t += 100) {
      r.at(t);
      r.poll();
    }
    expect(r.broken).toEqual([]);
    r.at(11_100);
    expect(r.poll()).toBeNull();
    expect(r.broken).toEqual(['lost']);
    // Closed: no more frames.
    r.at(11_150);
    expect(r.poll()).toBeNull();
    expect(r.captures).toBe(1);
  });

  test('failed frames in a row give the worker up; a good one resets the count', async () => {
    const r = rig({ maxErrors: 3 });
    let t = 0;
    const next = async () => {
      r.at((t += 50));
      r.poll();
      await r.flush();
      return r.sent.at(-1)!;
    };
    let s = await next();
    r.pump.fail(s.id, s.frame);
    s = await next();
    r.pump.fail(s.id, s.frame);
    s = await next();
    r.pump.deliver(s.id, reading(1), s.frame);
    s = await next();
    r.pump.fail(s.id, s.frame);
    s = await next();
    r.pump.fail(s.id, s.frame);
    expect(r.broken).toEqual([]);
    s = await next();
    r.pump.fail(s.id, null);
    expect(r.broken).toEqual(['errors']);
  });

  test('no video yet: nothing is in flight, the next poll tries again', () => {
    const r = rig();
    expect(r.pump.poll(() => null)).toBeNull();
    expect(r.pump.busy).toBe(false);
  });

  test('a capture that fails frees the slot', async () => {
    const r = rig();
    r.pump.poll(() => Promise.reject(new Error('InvalidStateError')));
    expect(r.pump.busy).toBe(true);
    await r.flush();
    expect(r.pump.busy).toBe(false);
  });

  test('frames that come back late or after close are freed, never kept', async () => {
    const r = rig();
    r.poll();
    await r.flush();
    r.pump.deliver(99, reading(1), 'stray');
    expect(r.dropped).toEqual(['stray']);
    r.pump.close();
    r.pump.deliver(1, reading(1), 'f1');
    expect(r.dropped).toEqual(['stray', 'f1']);
    expect(r.poll()).toBeNull();
  });

  test('a frame taken after close is freed instead of sent', async () => {
    const r = rig();
    r.poll();
    r.pump.close();
    await r.flush();
    expect(r.sent).toEqual([]);
    expect(r.dropped).toEqual(['f1']);
  });
});

describe('workerSupported', () => {
  const all = {
    Worker: function Worker() {},
    OffscreenCanvas: function OffscreenCanvas() {},
    createImageBitmap: () => {},
  };

  test('with Worker, OffscreenCanvas and createImageBitmap the worker is tried', () => {
    expect(workerSupported(all, null, 'abc')).toBe(true);
  });

  test('any of them missing: the tracker runs on the page', () => {
    expect(workerSupported({ ...all, Worker: undefined }, null, 'abc')).toBe(false);
    expect(workerSupported({ ...all, OffscreenCanvas: undefined }, null, 'abc')).toBe(false);
    expect(workerSupported({ ...all, createImageBitmap: undefined }, null, 'abc')).toBe(false);
  });

  test('a worker that failed in this build is not tried again; a new build tries again', () => {
    expect(workerSupported(all, 'abc', 'abc')).toBe(false);
    expect(workerSupported(all, 'abc', 'def')).toBe(true);
    expect(workerSupported(all, 'dev', null)).toBe(false);
  });
});
