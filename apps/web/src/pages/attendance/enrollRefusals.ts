/**
 * The photos a face enrollment was refused for, read from the server's
 * `attendance.errors.enrollRejected` error.
 */
import {
  isEnrollPose,
  isEnrollProblem,
  type EnrollPose,
  type EnrollProblem,
} from '@compass/contracts/schemas/faceEnroll';

/**
 * A refused photo and why. Review ATT-27: a reason this version does not
 * know reads as `unknown` ("could not be used"); the sheet used to drop
 * the line, and with it the only reason it had.
 */
export interface Refusal {
  pose: EnrollPose;
  problem: EnrollProblem | 'unknown';
}

/** The refusals in the error's context, e.g. `{ problems: 'front:dark,left:blurry' }`. */
export function readRefusals(context: unknown): Refusal[] {
  const list = (context as { problems?: unknown } | null | undefined)?.problems;
  if (typeof list !== 'string') return [];
  return list.split(',').flatMap((entry) => {
    const [pose = '', problem = ''] = entry.split(':');
    if (!isEnrollPose(pose)) return [];
    return [{ pose, problem: isEnrollProblem(problem) ? problem : 'unknown' }];
  });
}
