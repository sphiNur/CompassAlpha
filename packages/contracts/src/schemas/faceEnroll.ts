/**
 * The poses of a face enrollment and the reasons a photo is refused, read
 * by the server and the phone alike (review ATT-27: each kept its own
 * copy, and the phone dropped any reason missing from its copy, which
 * left the "photos could not be used" list empty).
 *
 * No zod here: the web imports this module, and a schema module would
 * bring all of zod with it (P-5, see limits.ts).
 */

/** Every pose, in the order they are shown: straight on, around the ring, straight on again. */
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
export const REQUIRED_ENROLL_POSES = [
  'front',
  'left',
  'right',
  'front2',
] as const satisfies readonly EnrollPose[];

/** Why the server refuses an enrollment photo. */
export const ENROLL_PROBLEMS = [
  'noFace',
  'manyFaces',
  'small',
  'dark',
  'bright',
  'blurry',
  'notFacing',
  'notTurned',
  'otherPerson',
  'spoof',
] as const;
export type EnrollProblem = (typeof ENROLL_PROBLEMS)[number];

export function isEnrollPose(value: string): value is EnrollPose {
  return (ENROLL_POSES as readonly string[]).includes(value);
}

export function isEnrollProblem(value: string): value is EnrollProblem {
  return (ENROLL_PROBLEMS as readonly string[]).includes(value);
}
