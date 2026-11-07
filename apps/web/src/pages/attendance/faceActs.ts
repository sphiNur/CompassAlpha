/**
 * The blink and open-mouth prompts on every punch (owner, 2026-11-07).
 * Fed one tracker reading per frame (~20 a second); says what to tell the
 * person and when to take the frame. The server cannot see eyelids, so the
 * phone decides that the movement happened; it then checks the frame is a
 * real face of the same person and not a copy (liveness.ts evaluateActs).
 *
 * Both are measured against the person's own resting face, read first:
 * some eyes rest half-closed, some mouths a little open.
 *   - blink: eyes at rest → shut → open again within a second. The frame
 *     is taken while they are shut. A photo cannot open its eyes again.
 *   - mouth: mouth at rest → open wide, held two frames. The frame is
 *     taken then.
 */
import type { FaceReading } from '../../lib/faceTracker';

export type Act = 'blink' | 'mouth';
export type ActGuide =
  | 'noFace'
  | 'manyFaces'
  | 'closer'
  | 'lookStraight'
  | 'openEyes'
  | 'closeMouth';

export const ACT_LINES = {
  /** Resting readings before the movement counts. */
  restFrames: 3,
  /** Looking roughly at the camera (the server allows 0.3). */
  maxYaw: 0.25,
  /** The face's width as a share of the frame. */
  minSize: 0.2,
  /** Eyes shut: at least this, and this much above their rest. */
  blinkShut: 0.45,
  blinkRise: 0.25,
  /** Eyes open again: within this of their rest. */
  blinkBack: 0.12,
  /** How long after shutting the eyes must open again. */
  blinkWindowMs: 1200,
  /** Mouth open: at least this, and this much above its rest. */
  jawOpen: 0.35,
  jawRise: 0.25,
  /** Open-mouth readings in a row before the frame is taken. */
  jawFrames: 2,
  /** A resting face: eyes and mouth at most this. */
  restMax: 0.4,
} as const;

export interface ActStep {
  guide: ActGuide | null;
  /** Take the current frame now (then call `took`). */
  grab: boolean;
  /** The movement is done and its frame kept. */
  done: boolean;
}

export function createActWatcher(act: Act) {
  const rest: number[] = [];
  let base: number | null = null;
  let shutAt: number | null = null;
  let kept = false;
  let openRun = 0;
  let done = false;
  let asked = false;

  const reset = () => {
    shutAt = null;
    kept = false;
    openRun = 0;
  };

  return {
    step(r: FaceReading, now: number): ActStep {
      asked = false;
      if (done) return { guide: null, grab: false, done: true };
      const score = act === 'blink' ? r.blink : r.jaw;
      if (r.count === 0 || r.yaw === null || score === null) {
        reset();
        return { guide: 'noFace', grab: false, done: false };
      }
      if (r.count > 1) return { guide: 'manyFaces', grab: false, done: false };
      if (r.size !== null && r.size < ACT_LINES.minSize) {
        return { guide: 'closer', grab: false, done: false };
      }
      if (Math.abs(r.yaw) > ACT_LINES.maxYaw) {
        reset();
        return { guide: 'lookStraight', grab: false, done: false };
      }

      // The resting face first.
      if (base === null) {
        if (score <= ACT_LINES.restMax) rest.push(score);
        else rest.length = 0;
        if (rest.length < ACT_LINES.restFrames) {
          const guide =
            score > ACT_LINES.restMax ? (act === 'blink' ? 'openEyes' : 'closeMouth') : null;
          return { guide, grab: false, done: false };
        }
        base = rest.reduce((a, b) => a + b, 0) / rest.length;
      }

      if (act === 'blink') {
        const shut = score >= Math.max(ACT_LINES.blinkShut, base + ACT_LINES.blinkRise);
        if (shutAt !== null && now - shutAt > ACT_LINES.blinkWindowMs) {
          // Eyes kept shut too long: a blink, not a closed-eyes picture.
          reset();
          return { guide: 'openEyes', grab: false, done: false };
        }
        if (shut) {
          if (shutAt === null) shutAt = now;
          if (!kept) {
            asked = true;
            return { guide: null, grab: true, done: false };
          }
          return { guide: null, grab: false, done: false };
        }
        if (kept && score <= base + ACT_LINES.blinkBack) {
          done = true;
          return { guide: null, grab: false, done: true };
        }
        return { guide: null, grab: false, done: false };
      }

      // The mouth.
      const open = score >= Math.max(ACT_LINES.jawOpen, base + ACT_LINES.jawRise);
      openRun = open ? openRun + 1 : 0;
      if (openRun >= ACT_LINES.jawFrames) {
        asked = true;
        return { guide: null, grab: true, done: false };
      }
      return { guide: null, grab: false, done: false };
    },

    /** The frame asked for by the last step was kept. */
    took() {
      if (!asked) return;
      asked = false;
      if (act === 'blink') kept = true;
      else done = true;
    },

    get done() {
      return done;
    },
  };
}
