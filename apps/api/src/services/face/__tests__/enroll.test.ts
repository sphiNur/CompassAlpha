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
    expect(evaluateEnrollment(good())).toMatchObject({ ok: true, problems: [], dropped: [] });
    expect(evaluateEnrollment(good()).kept).toHaveLength(10);
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
    const v = evaluateEnrollment(r);
    // Required photos refuse the enrollment...
    expect(v.problems).toEqual([
      { pose: 'left', problem: 'noFace' },
      { pose: 'front2', problem: 'manyFaces' },
      { pose: 'front2', problem: 'small' },
    ]);
    // ...optional ones are only left out.
    expect(v.dropped).toEqual([
      { pose: 'up', problem: 'dark' },
      { pose: 'down', problem: 'blurry' },
    ]);
  });

  test('a poor tilt or diagonal is left out, not refused (2026-11-07)', () => {
    const r = good();
    const q = { faces: 1, size: 0.35, light: 120, sharp: 200, pitch: 0.5 };
    r.downleft = { found: false };
    r.upright = face({ quality: { ...q, sharp: 3 } });
    r.down = face({ feature: unit(2) });
    // Turned far, the detector rates them less real; they do not count.
    r.upleft = face({ feature: unit(3), real: 0 });
    const v = evaluateEnrollment(r);
    expect(v.ok).toBe(true);
    expect(v.kept).toEqual(['front', 'right', 'up', 'left', 'downright', 'front2']);
    expect(v.dropped.map((d): string => d.pose).sort()).toEqual([
      'down',
      'downleft',
      'upleft',
      'upright',
    ]);
    expect(v.real).toBeCloseTo(0.95);
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
