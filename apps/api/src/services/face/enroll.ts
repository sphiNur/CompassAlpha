/**
 * Face enrollment (owner decisions 2026-11-06): face is the only way to
 * clock, so the reference must be good. The phone guides the person
 * through six photos, taken by itself when the head is where the prompt
 * asks: straight on, each side (in a random order), chin up, chin down,
 * straight on again. The server checks every photo here; a store manager
 * then looks at them and approves before the person can clock.
 *
 * Punches are matched against all six features (the best one counts), so
 * a punch with the head a little turned or tilted still matches well.
 */
import { cosine } from './index';
import { LIVENESS } from './liveness';
import type { FaceResult } from './pipeline';

export const ENROLL_POSES = ['front', 'left', 'right', 'up', 'down', 'front2'] as const;
export type EnrollPose = (typeof ENROLL_POSES)[number];

export const ENROLL_LINES = {
  /** The face's width as a share of the photo's. */
  minSize: 0.18,
  /** Mean brightness in the face box, 0–255. */
  minLight: 45,
  maxLight: 225,
  /** Variance of the Laplacian over the aligned face. */
  minSharp: 15,
  /** The two straight photos against each other. */
  sameFront: 0.45,
  /** Turned or tilted photos against the straight one. */
  samePose: 0.25,
  /** Mean real-face probability over all photos. */
  realMin: 0.5,
} as const;

export type EnrollProblem =
  | 'noFace'
  | 'manyFaces'
  | 'small'
  | 'dark'
  | 'bright'
  | 'blurry'
  | 'notFacing'
  | 'notTurned'
  | 'otherPerson'
  | 'spoof';

export interface EnrollVerdict {
  ok: boolean;
  /** Each photo's problems; empty when it is fine. */
  problems: { pose: EnrollPose; problem: EnrollProblem }[];
  /** Mean real-face probability. */
  real: number | null;
}

type Found = Extract<FaceResult, { found: true }>;

/** The six photos' face results → whether they make a good reference. */
export function evaluateEnrollment(results: Record<EnrollPose, FaceResult>): EnrollVerdict {
  const problems: EnrollVerdict['problems'] = [];
  const found: Partial<Record<EnrollPose, Found>> = {};
  for (const pose of ENROLL_POSES) {
    const r = results[pose];
    if (!r.found) {
      problems.push({ pose, problem: 'noFace' });
      continue;
    }
    found[pose] = r;
    const q = r.quality;
    if (!q) continue;
    if (q.faces > 1) problems.push({ pose, problem: 'manyFaces' });
    if (q.size < ENROLL_LINES.minSize) problems.push({ pose, problem: 'small' });
    if (q.light < ENROLL_LINES.minLight) problems.push({ pose, problem: 'dark' });
    if (q.light > ENROLL_LINES.maxLight) problems.push({ pose, problem: 'bright' });
    if (q.sharp < ENROLL_LINES.minSharp) problems.push({ pose, problem: 'blurry' });
  }
  const front = found.front;
  if (front) {
    for (const pose of ['front', 'front2'] as const) {
      const f = found[pose];
      if (f && Math.abs(f.yaw) > LIVENESS.frontMaxYaw)
        problems.push({ pose, problem: 'notFacing' });
    }
    // yaw > 0: turned to the person's own left (see yawOf).
    if (found.left && found.left.yaw < LIVENESS.turnMinYaw) {
      problems.push({ pose: 'left', problem: 'notTurned' });
    }
    if (found.right && found.right.yaw > -LIVENESS.turnMinYaw) {
      problems.push({ pose: 'right', problem: 'notTurned' });
    }
    for (const pose of ENROLL_POSES) {
      const f = found[pose];
      if (!f || pose === 'front') continue;
      const line = pose === 'front2' ? ENROLL_LINES.sameFront : ENROLL_LINES.samePose;
      if (cosine(front.feature, f.feature) < line) problems.push({ pose, problem: 'otherPerson' });
    }
  }
  const all = Object.values(found);
  const real = all.length ? all.reduce((a, f) => a + f.real, 0) / all.length : null;
  if (real !== null && real < ENROLL_LINES.realMin)
    problems.push({ pose: 'front', problem: 'spoof' });
  return { ok: problems.length === 0, problems, real };
}

/** A face against a person's enrolled features: the best one counts. */
export function bestScore(
  features: readonly (readonly number[])[],
  feature: readonly number[],
): number | null {
  let best: number | null = null;
  for (const f of features) {
    const s = cosine(f, feature);
    if (best === null || s > best) best = s;
  }
  return best;
}
