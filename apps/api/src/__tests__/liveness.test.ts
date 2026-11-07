import { describe, expect, test } from 'bun:test';
import { ACT_LINES, evaluateActs, evaluateLiveness, LIVENESS } from '../services/face/liveness';
import { yawOf, type Face } from '../services/face/pipeline';

const unit = (i: number) => Array.from({ length: 128 }, (_, j) => (j === i ? 1 : 0));
const frame = (yaw: number, opts: { who?: number; real?: number } = {}) => ({
  found: true as const,
  score: 0.9,
  feature: unit(opts.who ?? 0),
  yaw,
  real: opts.real ?? 0.95,
});

describe('liveness verdict', () => {
  test('straight, then turned left and right, real: pass', () => {
    const v = evaluateLiveness(frame(0.02), frame(0.5), frame(-0.5));
    expect(v.result).toBe('pass');
    expect(v.score).toBeCloseTo(0.95);
  });

  test('a flat picture tilted to the camera does not turn', () => {
    expect(evaluateLiveness(frame(0), frame(0.05), frame(-0.04)).failures).toEqual(['notTurned']);
  });

  test('turns the wrong way round fail', () => {
    expect(evaluateLiveness(frame(0), frame(-0.5), frame(0.5)).failures).toEqual(['notTurned']);
  });

  test('not looking at the camera on the straight frame fails', () => {
    expect(evaluateLiveness(frame(0.4), frame(0.5), frame(-0.5)).failures).toEqual(['notFacing']);
  });

  test('another person in the turn frames fails', () => {
    expect(evaluateLiveness(frame(0), frame(0.5, { who: 1 }), frame(-0.5)).failures).toEqual([
      'otherPerson',
    ]);
  });

  test('a print or a screen fails on the real-face score', () => {
    const v = evaluateLiveness(
      frame(0, { real: 0.1 }),
      frame(0.5, { real: 0.2 }),
      frame(-0.5, { real: 0.1 }),
    );
    expect(v.failures).toEqual(['spoof']);
    expect(v.score!).toBeLessThan(LIVENESS.realMin);
  });

  test('no face in a frame fails; a check that could not run is unchecked', () => {
    expect(evaluateLiveness(frame(0), { found: false }, frame(-0.5)).failures).toEqual(['noFace']);
    expect(evaluateLiveness(frame(0), null, frame(-0.5)).result).toBe('unchecked');
  });
});

describe('head turn from landmarks', () => {
  const face = (noseX: number): Face => ({
    box: [0, 0, 100, 100],
    score: 0.9,
    landmarks: [
      [30, 40],
      [70, 40],
      [noseX, 60],
      [35, 80],
      [65, 80],
    ],
  });
  test('nose between the eyes is straight; to the right in the picture is positive', () => {
    expect(yawOf(face(50))).toBe(0);
    expect(yawOf(face(70))).toBeCloseTo(0.5);
    expect(yawOf(face(30))).toBeCloseTo(-0.5);
  });
});

describe('evaluateActs (blink and open mouth, 2026-11-07)', () => {
  const unit = (i: number) => Array.from({ length: 128 }, (_, j) => (j === i ? 1 : 0));
  const near = (cos: number) =>
    Array.from({ length: 128 }, (_, j) => (j === 0 ? cos : j === 1 ? Math.sqrt(1 - cos * cos) : 0));
  const f = (o: { feature?: number[]; yaw?: number; real?: number } = {}) => ({
    found: true as const,
    score: 0.95,
    feature: o.feature ?? near(0.9),
    yaw: o.yaw ?? 0,
    real: o.real ?? 0.95,
  });
  const front = f({ feature: unit(0) });
  const act = (
    act: 'blink' | 'mouth',
    result: ReturnType<typeof f> | { found: false } | null,
    copy = false,
  ) => ({
    act,
    result,
    copy,
  });

  test('two real frames of the same person pass', () => {
    expect(evaluateActs(front, [act('blink', f()), act('mouth', f())])).toMatchObject({
      result: 'pass',
      failures: [],
    });
  });

  test('each way to fail', () => {
    expect(evaluateActs(front, [act('blink', null), act('mouth', f())]).result).toBe('unchecked');
    expect(
      evaluateActs(front, [act('blink', { found: false }), act('mouth', f())]).failures,
    ).toEqual(['noFace']);
    expect(evaluateActs(front, [act('blink', f(), true), act('mouth', f())]).failures).toEqual([
      'sameFrame',
    ]);
    expect(
      evaluateActs(front, [act('blink', f({ feature: unit(0) })), act('mouth', f())]).failures,
    ).toEqual(['sameFrame']);
    expect(
      evaluateActs(front, [act('blink', f({ feature: unit(3) })), act('mouth', f())]).failures,
    ).toEqual(['otherPerson']);
    expect(
      evaluateActs(front, [act('blink', f({ yaw: ACT_LINES.maxYaw + 0.1 })), act('mouth', f())])
        .failures,
    ).toEqual(['notFacing']);
    const prints = [act('blink', f({ real: 0.05 })), act('mouth', f({ real: 0.05 }))];
    expect(evaluateActs({ ...front, real: 0.05 }, prints).failures).toEqual(['spoof']);
  });
});
