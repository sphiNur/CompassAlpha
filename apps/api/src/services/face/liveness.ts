/**
 * Liveness on clock-in photos (owner request 2026-11-06).
 *
 * The phone shows the person live prompts ("turn left", "turn right", in
 * an order the server picks) and sends three frames: straight on, turned
 * left, turned right. The server decides, never the phone:
 *   - every frame has a face, and the faces are one person;
 *   - the straight frame looks at the camera and the turned frames are
 *     turned the way they say. A printed photo or a screen tilted in
 *     front of the camera shifts as one flat plane, so the nose does not
 *     move against the eyes the way a real head's does;
 *   - the MiniFASNet pair (Silent-Face) finds a real face, not a print or
 *     a screen, on average across the three frames.
 * The challenge is a signed token naming whose punch it is, good for one
 * punch (`liveness_nonce` is unique) and three minutes.
 *
 * Blink and mouth (owner, 2026-11-07): every punch also shows a blink and
 * an open mouth, in an order the server picks. The phone's face mesh sees
 * them and takes the frame at that moment; the server's five-point model
 * cannot see eyelids, so it checks what it can: each frame is a real face
 * of the same person, looking roughly at the camera, and not a copy of
 * another frame. A print or a screen cannot blink.
 *
 * Limits: a deep-fake video fed straight into the camera stream is not
 * something two small models catch; the scene photo, the bound phone and
 * the store's location are the other locks.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../../env';
import type { FaceResult } from './pipeline';
import { cosine } from './index';

const secret = new TextEncoder().encode(env.JWT_SECRET);
const AUDIENCE = 'attendance-liveness';

export type Turn = 'left' | 'right';
/** The face movements asked for on every punch (2026-11-07). */
export type Act = 'blink' | 'mouth';

export interface LivenessClaims {
  org: string;
  /** Whose punch this is (a colleague when clocking on a borrowed phone). */
  mid: string;
  /** Who asked: the phone's own member. */
  by: string;
  storeId: string;
  steps: Turn[];
  /** Missing on a token from before 2026-11-07: no movements asked. */
  acts?: Act[];
  nonce: string;
}

/** Both movements, in a random order. */
export function randomActs(): Act[] {
  return randomInt(2) === 0 ? ['blink', 'mouth'] : ['mouth', 'blink'];
}

/** Both turns, in a random order. */
export function randomSteps(): Turn[] {
  return randomInt(2) === 0 ? ['left', 'right'] : ['right', 'left'];
}

export async function signLivenessToken(
  claims: Omit<LivenessClaims, 'nonce' | 'steps' | 'acts'> & { steps?: Turn[]; acts?: Act[] },
): Promise<{ token: string; steps: Turn[]; acts: Act[]; nonce: string }> {
  const steps = claims.steps ?? randomSteps();
  const acts = claims.acts ?? randomActs();
  const nonce = randomBytes(18).toString('base64url');
  const token = await new SignJWT({ ...claims, steps, acts, nonce })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('3m')
    .sign(secret);
  return { token, steps, acts, nonce };
}

/** The claims, or null for a bad or expired token. */
export async function verifyLivenessToken(token: string): Promise<LivenessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { audience: AUDIENCE });
    return payload as unknown as LivenessClaims;
  } catch {
    return null;
  }
}

export const LIVENESS = {
  /** |yaw| of the straight-on frame. */
  frontMaxYaw: 0.2,
  /**
   * |yaw| a turned frame must reach (the phone waits for 0.35). YuNet's
   * landmarks read a turn to one side smaller than the same turn to the
   * other, so this stays low; a flat picture tilted in front of the camera
   * reads near 0.
   */
  turnMinYaw: 0.2,
  /** Turned frames against the straight one: a turned face matches less well. */
  samePerson: 0.25,
  /** Mean real-face probability over the three frames. */
  realMin: 0.5,
} as const;

export type LivenessFailure =
  | 'noFace'
  | 'notFacing'
  | 'notTurned'
  | 'otherPerson'
  | 'spoof'
  | 'sameFrame';

export interface LivenessVerdict {
  /** `passive`: no turns asked, one photo plainly of a real face. */
  result: 'pass' | 'fail' | 'unchecked' | 'passive';
  /** Mean real-face probability, when the frames were read. */
  score: number | null;
  failures: LivenessFailure[];
}

/**
 * The three frames' face results → the verdict. A null result means the
 * check could not run (worker down): `unchecked`, not a failure.
 */
export function evaluateLiveness(
  front: FaceResult | null,
  left: FaceResult | null,
  right: FaceResult | null,
): LivenessVerdict {
  if (!front || !left || !right) return { result: 'unchecked', score: null, failures: [] };
  if (!front.found || !left.found || !right.found) {
    return { result: 'fail', score: null, failures: ['noFace'] };
  }
  const failures: LivenessFailure[] = [];
  if (Math.abs(front.yaw) > LIVENESS.frontMaxYaw) failures.push('notFacing');
  // yaw > 0: turned to the person's own left (see yawOf).
  if (left.yaw < LIVENESS.turnMinYaw || right.yaw > -LIVENESS.turnMinYaw) {
    failures.push('notTurned');
  }
  if (
    cosine(front.feature, left.feature) < LIVENESS.samePerson ||
    cosine(front.feature, right.feature) < LIVENESS.samePerson
  ) {
    failures.push('otherPerson');
  }
  const score = (front.real + left.real + right.real) / 3;
  if (score < LIVENESS.realMin) failures.push('spoof');
  return { result: failures.length ? 'fail' : 'pass', score, failures };
}

export const ACT_LINES = {
  /** |yaw| of a movement frame: roughly at the camera. */
  maxYaw: 0.3,
  /** A blink or an open mouth against the straight frame: the same person. */
  samePerson: 0.4,
  /** Above this the two frames are one picture sent twice. */
  sameFrame: 0.9995,
  /** Mean real-face probability over the straight frame and the movements. */
  realMin: 0.5,
} as const;

type Found = Extract<FaceResult, { found: true }>;

/**
 * The movement frames (blink, open mouth) against the straight frame.
 * Null results: the check could not run (`unchecked`). `copies` lists the
 * movements whose bytes equal the straight frame's or another's.
 */
export function evaluateActs(
  front: Found,
  acts: readonly { act: Act; result: FaceResult | null; copy: boolean }[],
): LivenessVerdict {
  if (acts.some((a) => !a.result)) return { result: 'unchecked', score: null, failures: [] };
  const failures = new Set<LivenessFailure>();
  const found: Found[] = [];
  for (const a of acts) {
    const r = a.result!;
    if (!r.found) {
      failures.add('noFace');
      continue;
    }
    found.push(r);
    if (a.copy || cosine(front.feature, r.feature) > ACT_LINES.sameFrame) failures.add('sameFrame');
    if (Math.abs(r.yaw) > ACT_LINES.maxYaw) failures.add('notFacing');
    if (cosine(front.feature, r.feature) < ACT_LINES.samePerson) failures.add('otherPerson');
  }
  const all = [front, ...found];
  const score = all.reduce((t, f) => t + f.real, 0) / all.length;
  if (score < ACT_LINES.realMin) failures.add('spoof');
  return { result: failures.size ? 'fail' : 'pass', score, failures: [...failures] };
}
