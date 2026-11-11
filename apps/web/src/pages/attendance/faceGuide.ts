/**
 * When the face tracker may take a frame (2026-11-06): the first checks
 * every step makes, and the hold before the frame is taken. Kept apart
 * from the camera hooks in faceCapture.ts, which load the tracker, so it
 * is testable (review TEST3-08, 2026-11-10).
 */
import type { FaceReading } from '../../lib/faceTracker';

/** What the person should do before the frame is taken; null = hold still. */
export type Guide =
  | 'noFace'
  | 'manyFaces'
  | 'closer'
  | 'lookStraight'
  | 'turnMore'
  | 'chinUp'
  | 'chinDown'
  | 'openEyes'
  | 'closeMouth';

/** The usual first checks: one face, close enough. */
export function basicGuide(r: FaceReading, minSize = 0.28): Guide | null {
  if (r.count === 0 || r.yaw === null) return 'noFace';
  if (r.count > 1) return 'manyFaces';
  if (r.size !== null && r.size < minSize) return 'closer';
  return null;
}

/** Readings in a row (~120 ms apart) before the frame is taken. */
export const HOLD = 3;

/**
 * Counts the readings in a row that need no guide: true from the HOLD-th
 * on, when the frame is taken. Any guide starts the count again.
 */
export function steadyCounter(hold = HOLD): (guide: Guide | null) => boolean {
  let held = 0;
  return (guide) => {
    held = guide === null ? held + 1 : 0;
    return held >= hold;
  };
}
