import { describe, expect, test } from 'bun:test';
import type { FaceReading } from '../../lib/faceTracker';
import { ACT_LINES, createActWatcher, type Act } from './faceActs';

const face = (over: Partial<FaceReading> = {}): FaceReading => ({
  count: 1,
  yaw: 0,
  pitch: 0.5,
  size: 0.4,
  cx: 0.5,
  cy: 0.5,
  blink: 0.05,
  jaw: 0.02,
  ...over,
});

/** Feed readings 50 ms apart, keeping every frame asked for. */
function run(act: Act, readings: FaceReading[], w = createActWatcher(act), t0 = 0) {
  let grabs = 0;
  let t = t0;
  let last = null as ReturnType<typeof w.step> | null;
  for (const r of readings) {
    t += 50;
    last = w.step(r, t);
    if (last.grab) {
      grabs += 1;
      w.took();
    }
  }
  return { w, grabs, last: last!, t };
}

const rest = (n = 3, over: Partial<FaceReading> = {}) =>
  Array.from({ length: n }, () => face(over));

describe('blink', () => {
  test('open, shut, open again: one frame, done', () => {
    const { grabs, last } = run('blink', [
      ...rest(),
      face({ blink: 0.8 }),
      face({ blink: 0.85 }),
      face({ blink: 0.1 }),
    ]);
    expect(grabs).toBe(1);
    expect(last.done).toBe(true);
  });

  test('eyes that stay shut are not a blink (a closed-eyes photo)', () => {
    const shut = Array.from({ length: 40 }, () => face({ blink: 0.9 }));
    const { last } = run('blink', [...rest(), ...shut]);
    expect(last.done).toBe(false);
  });

  test('a still face never blinks', () => {
    const { grabs, last } = run('blink', rest(30));
    expect(grabs).toBe(0);
    expect(last.done).toBe(false);
  });

  test('eyes resting half closed: measured from their own rest', () => {
    // Rest 0.35: 0.5 is not shut for them, 0.75 is.
    const { grabs } = run('blink', [...rest(3, { blink: 0.35 }), face({ blink: 0.5 })]);
    expect(grabs).toBe(0);
    const { last } = run('blink', [
      ...rest(3, { blink: 0.35 }),
      face({ blink: 0.75 }),
      face({ blink: 0.36 }),
    ]);
    expect(last.done).toBe(true);
  });

  test('starting with the eyes shut: asked to open them first', () => {
    const { last } = run('blink', [face({ blink: 0.9 })]);
    expect(last.guide).toBe('openEyes');
  });

  test('turned away or two faces: guided, nothing taken', () => {
    expect(run('blink', [...rest(), face({ yaw: 0.4, blink: 0.9 })]).last.guide).toBe(
      'lookStraight',
    );
    expect(run('blink', [face({ count: 2 })]).last.guide).toBe('manyFaces');
    expect(run('blink', [face({ size: 0.1 })]).last.guide).toBe('closer');
  });
});

describe('open mouth', () => {
  test('rest, then open wide two frames: one frame, done', () => {
    const { grabs, w } = run('mouth', [...rest(), face({ jaw: 0.5 }), face({ jaw: 0.55 })]);
    expect(grabs).toBe(1);
    expect(w.done).toBe(true);
  });

  test('a mouth that is open from the start must close first', () => {
    const { grabs, last } = run(
      'mouth',
      Array.from({ length: 10 }, () => face({ jaw: 0.6 })),
    );
    expect(grabs).toBe(0);
    expect(last.guide).toBe('closeMouth');
  });

  test('a small opening is not enough', () => {
    const small = Array.from({ length: 5 }, () => face({ jaw: ACT_LINES.jawOpen - 0.1 }));
    expect(run('mouth', [...rest(), ...small]).grabs).toBe(0);
  });

  test('a frame the camera could not give is asked for again', () => {
    const w = createActWatcher('mouth');
    for (const r of rest()) w.step(r, 0);
    w.step(face({ jaw: 0.5 }), 50);
    expect(w.step(face({ jaw: 0.5 }), 100).grab).toBe(true);
    // not kept: no took()
    expect(w.step(face({ jaw: 0.5 }), 150).grab).toBe(true);
    expect(w.done).toBe(false);
  });
});
