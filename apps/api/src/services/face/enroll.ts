/**
 * Face enrollment (owner decisions 2026-11-06): face is the only way to
 * clock, so the reference must be good. Like Face ID, the person looks
 * into a ring and turns their head in a slow circle; the phone keeps a
 * photo straight on, one in each of eight directions as the head passes
 * them, and straight on again at the end. Straight on (twice) and the two
 * side turns are required (they carry the liveness check); the tilts and
 * diagonals are kept when the phone caught them well, and left out
 * otherwise. The server checks every
 * photo here; a store manager then approves before the person can clock.
 *
 * Punches are matched against all the features (the best one counts), so
 * a punch with the head a little turned or tilted still matches well.
 */
import { cosine } from './index';
import { LIVENESS } from './liveness';
import type { FaceResult } from './pipeline';

/** Every pose, in the order they are shown: around the ring, then straight again. */
export const ENROLL_POSES = [
  'front',
  'right',
  'upright',
  'up',
  'upleft',
  'left',
  'downleft',
  'down',
  'downright',
  'front2',
] as const;
export type EnrollPose = (typeof ENROLL_POSES)[number];
/** Without these an enrollment is refused. */
export const REQUIRED_POSES = ['front', 'left', 'right', 'front2'] as const;

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
  /** Problems with the required photos; any one refuses the enrollment. */
  problems: { pose: EnrollPose; problem: EnrollProblem }[];
  /** The photos to keep: the required ones and the optional ones without problems. */
  kept: EnrollPose[];
  /**
   * Optional photos left out, and why (2026-11-07): a tilt or diagonal
   * caught while the head was moving can be blurred or too turned for the
   * detector. That used to refuse the whole enrollment; now the photo is
   * just not kept.
   */
  dropped: { pose: EnrollPose; problem: EnrollProblem }[];
  /** Mean real-face probability over the kept photos. */
  real: number | null;
}

type Found = Extract<FaceResult, { found: true }>;

const isRequired = (pose: EnrollPose) => (REQUIRED_POSES as readonly string[]).includes(pose);

/** The photos' face results → whether they make a good reference, and which to keep. */
export function evaluateEnrollment(
  results: Partial<Record<EnrollPose, FaceResult>>,
): EnrollVerdict {
  const all: EnrollVerdict['problems'] = [];
  const found: Partial<Record<EnrollPose, Found>> = {};
  for (const pose of ENROLL_POSES) {
    const r = results[pose];
    if (!r) {
      if (isRequired(pose)) all.push({ pose, problem: 'noFace' });
      continue;
    }
    if (!r.found) {
      all.push({ pose, problem: 'noFace' });
      continue;
    }
    found[pose] = r;
    const q = r.quality;
    if (!q) continue;
    if (q.faces > 1) all.push({ pose, problem: 'manyFaces' });
    if (q.size < ENROLL_LINES.minSize) all.push({ pose, problem: 'small' });
    if (q.light < ENROLL_LINES.minLight) all.push({ pose, problem: 'dark' });
    if (q.light > ENROLL_LINES.maxLight) all.push({ pose, problem: 'bright' });
    if (q.sharp < ENROLL_LINES.minSharp) all.push({ pose, problem: 'blurry' });
  }
  const front = found.front;
  if (front) {
    for (const pose of ['front', 'front2'] as const) {
      const f = found[pose];
      if (f && Math.abs(f.yaw) > LIVENESS.frontMaxYaw) all.push({ pose, problem: 'notFacing' });
    }
    // yaw > 0: turned to the person's own left (see yawOf).
    if (found.left && found.left.yaw < LIVENESS.turnMinYaw) {
      all.push({ pose: 'left', problem: 'notTurned' });
    }
    if (found.right && found.right.yaw > -LIVENESS.turnMinYaw) {
      all.push({ pose: 'right', problem: 'notTurned' });
    }
    for (const pose of ENROLL_POSES) {
      const f = found[pose];
      if (!f || pose === 'front') continue;
      const line = pose === 'front2' ? ENROLL_LINES.sameFront : ENROLL_LINES.samePose;
      if (cosine(front.feature, f.feature) < line) all.push({ pose, problem: 'otherPerson' });
    }
  }
  const problems = all.filter((p) => isRequired(p.pose));
  const dropped = all.filter((p) => !isRequired(p.pose));
  const kept = ENROLL_POSES.filter((pose) => found[pose] && !dropped.some((d) => d.pose === pose));
  const keptFound = kept.map((pose) => found[pose]!);
  const real = keptFound.length
    ? keptFound.reduce((a, f) => a + f.real, 0) / keptFound.length
    : null;
  if (real !== null && real < ENROLL_LINES.realMin)
    problems.push({ pose: 'front', problem: 'spoof' });
  return { ok: problems.length === 0, problems, kept, dropped, real };
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
