import { describe, expect, test } from 'bun:test';
import {
  createRingSession,
  headDirection,
  PITCH_FULL,
  poseAt,
  RING,
  TICKS,
  ticksNear,
  ticksOf,
  YAW_FULL,
  type EnrollShot,
  type RingReading,
} from './faceRing';

describe('face ring', () => {
  test('the person turning to their own right lights the screen right', () => {
    // yaw < 0: turned to their own right (the server's "right" pose).
    const d = headDirection(-0.4, 0.5, 0.5);
    expect(Math.round(d.angle)).toBe(0);
    expect(poseAt(d)).toBe('right');
    expect(poseAt(headDirection(0.4, 0.5, 0.5))).toBe('left');
  });

  test('chin up is up, chin down is down', () => {
    expect(poseAt(headDirection(0, 0.38, 0.5))).toBe('up');
    expect(poseAt(headDirection(0, 0.62, 0.5))).toBe('down');
  });

  test('diagonals combine a half turn and a half tilt', () => {
    expect(poseAt(headDirection(-0.27, 0.42, 0.5))).toBe('upright');
    expect(poseAt(headDirection(0.27, 0.58, 0.5))).toBe('downleft');
  });

  test('not far enough, or between two directions, is nothing', () => {
    expect(poseAt(headDirection(-0.2, 0.5, 0.5))).toBeNull();
    // Far enough, but a side needs the turn sideways alone.
    expect(poseAt(headDirection(-0.25, 0.47, 0.5))).toBeNull();
    // 22.5° off every direction.
    const between = headDirection(
      -0.35 * Math.cos(Math.PI / 8),
      0.5 - 0.1 * Math.sin(Math.PI / 8),
      0.5,
    );
    expect(between.reach).toBeCloseTo(1);
    expect(poseAt(between)).toBeNull();
  });

  test('the eight directions fill the whole ring', () => {
    const lit = new Set(RING.flatMap((r) => ticksOf(r.pose)));
    expect(lit.size).toBe(TICKS);
    expect(ticksNear(0, 6)).toEqual([0, 1, 59]);
  });
});

const face = (yaw: number, pitch: number, extra: Partial<RingReading> = {}): RingReading => ({
  count: 1,
  yaw,
  pitch,
  size: 0.4,
  cx: 0.5,
  cy: 0.5,
  ...extra,
});

/** Feed readings 50 ms apart, keeping every frame asked for. */
function run(session: ReturnType<typeof createRingSession>, readings: RingReading[], t0 = 0) {
  const kept: EnrollShot[] = [];
  let t = t0;
  let last = null as ReturnType<typeof session.step> | null;
  for (const r of readings) {
    t += 50;
    last = session.step(r, t);
    if (last.grab) {
      session.took(last.grab);
      kept.push(last.grab);
    }
  }
  return { kept, last: last!, t };
}

/** A slow circle: `n` frames around, at `reach` full turns, starting at the screen's right. */
function circle(n: number, reach = 1.1, base = 0.5): RingReading[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    return face(-Math.cos(a) * reach * YAW_FULL, base - Math.sin(a) * reach * PITCH_FULL);
  });
}

describe('ring session', () => {
  test('a steady straight face starts the ring at once', () => {
    const s = createRingSession();
    const { kept, last } = run(s, [
      face(0.01, 0.5),
      face(0.01, 0.5),
      face(0.01, 0.5),
      face(0.01, 0.5),
    ]);
    expect(kept).toEqual(['front']);
    expect(last.grab).toBe('front');
    expect(s.stage).toBe('circle');
  });

  test('guides until the face is in place', () => {
    const s = createRingSession();
    expect(
      s.step({ count: 0, yaw: null, pitch: null, size: null, cx: null, cy: null }, 0).guide,
    ).toBe('noFace');
    expect(s.step(face(0, 0.5, { count: 2 }), 50).guide).toBe('manyFaces');
    expect(s.step(face(0, 0.5, { size: 0.15 }), 100).guide).toBe('closer');
    expect(s.step(face(0, 0.5, { cx: 0.85 }), 150).guide).toBe('center');
    expect(s.step(face(0.3, 0.5), 200).guide).toBe('lookStraight');
    expect(s.stage).toBe('position');
  });

  test('one slow circle fills the ring, keeps all eight, then the last straight frame', () => {
    const s = createRingSession();
    const start = run(s, Array(4).fill(face(0, 0.5)));
    const round = run(s, circle(80), start.t);
    expect(new Set(round.kept)).toEqual(new Set(RING.map((r) => r.pose)));
    expect(round.last.stage).toBe('final');
    expect(round.last.lit.size).toBe(TICKS);
    const end = run(s, Array(4).fill(face(0, 0.5)), round.t);
    expect(end.kept).toEqual(['front2']);
    expect(s.stage).toBe('over');
  });

  test('ticks follow the head, only where it points', () => {
    const s = createRingSession();
    const start = run(s, Array(4).fill(face(0, 0.5)));
    // Held to the screen's right (their own right): yaw < 0.
    const { last } = run(s, Array(6).fill(face(-0.4, 0.5)), start.t);
    expect(last.lit.has(0)).toBe(true);
    expect(last.lit.has(TICKS / 2)).toBe(false);
    expect(last.lit.size).toBeLessThan(6);
  });

  test('the tilt is measured from where they looked straight', () => {
    const s = createRingSession();
    // Their straight pitch is 0.6, not 0.5: 0.6 is not "down" for them.
    const start = run(s, Array(4).fill(face(0, 0.6)));
    const { kept } = run(s, Array(6).fill(face(0, 0.6)), start.t);
    expect(kept).toEqual([]);
    const up = run(s, Array(4).fill(face(0, 0.5)), start.t + 300);
    expect(up.kept).toContain('up');
  });

  test('a steadier frame replaces a direction kept while moving', () => {
    const s = createRingSession();
    const start = run(s, Array(4).fill(face(0, 0.5)));
    const moving = run(s, [face(-0.4, 0.5), face(-0.45, 0.5)], start.t);
    expect(moving.kept).toEqual(['right']);
    const still = run(s, Array(10).fill(face(-0.4, 0.5)), moving.t);
    expect(still.kept).toEqual(['right']);
  });

  test('after a while, both sides are enough', () => {
    const s = createRingSession();
    const start = run(s, Array(4).fill(face(0, 0.5)));
    const sides = run(
      s,
      [...Array(4).fill(face(-0.4, 0.5)), ...Array(4).fill(face(0.4, 0.5))],
      start.t,
    );
    expect(sides.last.stage).toBe('circle');
    const later = s.step(face(0.4, 0.5), start.t + 31_000);
    expect(later.stage).toBe('final');
    expect(later.slow).toBe(false);
  });

  test('a frame the camera could not give is asked for again', () => {
    const s = createRingSession();
    run(s, Array(3).fill(face(0, 0.5)));
    const a = s.step(face(0, 0.5), 1000);
    expect(a.grab).toBe('front');
    // not kept: no took()
    const b = s.step(face(0, 0.5), 1050);
    expect(b.grab).toBe('front');
  });
});
