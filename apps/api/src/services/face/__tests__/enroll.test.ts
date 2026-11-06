import { describe, expect, test } from 'bun:test';
import { bestScore, evaluateEnrollment, type EnrollPose } from '../enroll';
import type { FaceResult } from '../pipeline';

const unit = (i: number) => Array.from({ length: 128 }, (_, j) => (j === i ? 1 : 0));
/** A feature mostly like `unit(0)`, with `cos` similarity to it. */
const near = (cos: number) =>
  Array.from({ length: 128 }, (_, j) => (j === 0 ? cos : j === 1 ? Math.sqrt(1 - cos * cos) : 0));

const face = (over: Partial<Extract<FaceResult, { found: true }>> = {}): FaceResult => ({
  found: true,
  score: 0.95,
  feature: unit(0),
  yaw: 0,
  real: 0.95,
  quality: { faces: 1, size: 0.35, light: 120, sharp: 200, pitch: 0.5 },
  ...over,
});

function good(): Partial<Record<EnrollPose, FaceResult>> {
  return {
    front: face(),
    left: face({ yaw: 0.5, feature: near(0.7) }),
    right: face({ yaw: -0.5, feature: near(0.7) }),
    up: face({ feature: near(0.8) }),
    down: face({ feature: near(0.8) }),
    upleft: face({ yaw: 0.25, feature: near(0.75) }),
    upright: face({ yaw: -0.25, feature: near(0.75) }),
    downleft: face({ yaw: 0.25, feature: near(0.75) }),
    downright: face({ yaw: -0.25, feature: near(0.75) }),
    front2: face({ feature: near(0.9) }),
  };
}

describe('evaluateEnrollment', () => {
  test('the whole ring passes', () => {
    expect(evaluateEnrollment(good())).toMatchObject({ ok: true, problems: [] });
  });

  test('tilts and diagonals are optional; straight twice and both sides are not', () => {
    const r = good();
    delete r.up;
    delete r.downleft;
    delete r.upright;
    expect(evaluateEnrollment(r).ok).toBe(true);
    delete r.left;
    delete r.front2;
    expect(evaluateEnrollment(r).problems).toEqual([
      { pose: 'left', problem: 'noFace' },
      { pose: 'front2', problem: 'noFace' },
    ]);
  });

  test('each photo is checked for quality', () => {
    const r = good();
    const q = { faces: 1, size: 0.35, light: 120, sharp: 200, pitch: 0.5 };
    r.up = face({ quality: { ...q, light: 10 } });
    r.down = face({ quality: { ...q, sharp: 2 } });
    r.front2 = face({ quality: { ...q, faces: 2, size: 0.1 } });
    r.left = { found: false };
    expect(evaluateEnrollment(r).problems).toEqual([
      { pose: 'up', problem: 'dark' },
      { pose: 'left', problem: 'noFace' },
      { pose: 'down', problem: 'blurry' },
      { pose: 'front2', problem: 'manyFaces' },
      { pose: 'front2', problem: 'small' },
    ]);
  });

  test('the turns, the same person, a real face', () => {
    const r = good();
    r.left = face({ yaw: 0.05 });
    r.front2 = face({ feature: unit(1) });
    expect(evaluateEnrollment(r).problems).toEqual([
      { pose: 'left', problem: 'notTurned' },
      { pose: 'front2', problem: 'otherPerson' },
    ]);
    const spoof = good();
    for (const f of Object.values(spoof)) (f as { real: number }).real = 0.2;
    expect(evaluateEnrollment(spoof).problems).toEqual([{ pose: 'front', problem: 'spoof' }]);
  });
});

describe('bestScore', () => {
  test('the best of the enrolled features counts', () => {
    expect(bestScore([unit(1), near(0.6), unit(0)], unit(0))).toBeCloseTo(1);
    expect(bestScore([unit(1), near(0.6)], unit(0))).toBeCloseTo(0.6);
    expect(bestScore([], unit(0))).toBeNull();
  });
});
