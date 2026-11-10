/**
 * The Face ID-style enrollment ring (2026-11-06; continuous since
 * 2026-11-07): where the head points, as seen on the mirrored preview,
 * which ticks of the ring it lights, and which camera frames are kept.
 *
 * The tracker gives yaw (positive = turned to the person's own left) and
 * pitch (the nose between eyes and mouth; smaller with the chin up). On
 * the mirrored preview the person's own right is the screen's right, so
 * screen x = -yaw and screen y (up) = straight-on pitch - pitch. Pitch
 * moves less than yaw for the same head movement, so each is scaled to
 * "a full turn" before they are combined.
 */

import type { EnrollPose } from '@compass/contracts/schemas/faceEnroll';

/** Ticks around the ring. */
export const TICKS = 60;
/** A full turn sideways (the server wants 0.2; the punch camera waits for 0.35). */
export const YAW_FULL = 0.35;
/** A full tilt up or down, in pitch units. */
export const PITCH_FULL = 0.1;

/** How far (1 = a full turn) the head must point for a tick to light or a frame to be kept. */
export const REACH = 0.8;

/** The eight poses around the ring: every enrollment pose but the two straight ones. */
export type RingPose = Exclude<EnrollPose, 'front' | 'front2'>;

/** The eight directions, counter-clockwise from the screen's right. */
export const RING: readonly { pose: RingPose; angle: number }[] = [
  { pose: 'right', angle: 0 },
  { pose: 'upright', angle: 45 },
  { pose: 'up', angle: 90 },
  { pose: 'upleft', angle: 135 },
  { pose: 'left', angle: 180 },
  { pose: 'downleft', angle: 225 },
  { pose: 'down', angle: 270 },
  { pose: 'downright', angle: 315 },
];

export interface HeadDirection {
  /** 0–360, counter-clockwise from the screen's right. */
  angle: number;
  /** 1 = a full turn in that direction. */
  reach: number;
  x: number;
  y: number;
}

export function headDirection(yaw: number, pitch: number, basePitch: number): HeadDirection {
  const x = -yaw / YAW_FULL;
  const y = (basePitch - pitch) / PITCH_FULL;
  const angle = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return { angle, reach: Math.hypot(x, y), x, y };
}

function gap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * The direction the head is in, when it is turned far enough and close
 * to one of the eight. The sides need the turn sideways alone (the server
 * checks them for liveness: REACH × YAW_FULL is above its 0.2); the
 * others the reach overall.
 */
export function poseAt(d: HeadDirection): RingPose | null {
  if (d.reach < REACH) return null;
  const hit = RING.find((r) => gap(r.angle, d.angle) <= 20);
  if (!hit) return null;
  if ((hit.pose === 'left' || hit.pose === 'right') && Math.abs(d.x) < REACH) return null;
  return hit.pose;
}

/** Ticks within `width` degrees of `angle`. */
export function ticksNear(angle: number, width: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < TICKS; i++) if (gap((i * 360) / TICKS, angle) <= width) out.push(i);
  return out;
}

/** The ticks a captured direction fills: its eighth of the ring. */
export function ticksOf(pose: RingPose): number[] {
  return ticksNear(RING.find((r) => r.pose === pose)!.angle, 360 / 16);
}

// ---------------------------------------------------------------------------
// The session: one reading per video frame in; what to show and which
// frame to keep out. Kept apart from the camera so it can be tested.

export type EnrollShot = EnrollPose;
export type RingGuide = 'noFace' | 'manyFaces' | 'closer' | 'center' | 'lookStraight';
export type RingStage = 'position' | 'circle' | 'final' | 'over';

export interface RingReading {
  count: number;
  yaw: number | null;
  pitch: number | null;
  size: number | null;
  cx: number | null;
  cy: number | null;
}

export const RING_LINES = {
  /** Closer than for a punch: the references should be sharp. */
  minSize: 0.25,
  /** How far off the middle of the frame the face may be. */
  centerX: 0.18,
  centerY: 0.22,
  /** Looking straight (server units; the server refuses above 0.12). */
  straight: 0.1,
  /** Steady frames in a row before a straight frame is kept. */
  steadyFrames: 3,
  /** Head movement per frame (in full turns) still counted as steady. */
  steady: 0.08,
  /** Ticks lit each side of where the head points (degrees). */
  pointer: 7,
  /** A direction's frame is replaced by a steadier one at most this often. */
  regrabMs: 300,
  /** After this long in the circle, a hint to go slower and wider. */
  slowHintMs: 12_000,
  /** After this long, the circle finishes without the directions it missed. */
  giveUpMs: 30_000,
  /** Smoothing of the turn and tilt (share of the new reading). */
  smooth: 0.5,
} as const;

export interface RingStep {
  stage: RingStage;
  guide: RingGuide | null;
  /** Keep the current frame as this shot (then call `took`). */
  grab: EnrollShot | null;
  /** Ticks lit (the same Set until it changes). */
  lit: ReadonlySet<number>;
  slow: boolean;
}

export function createRingSession() {
  let stage: RingStage = 'position';
  let lit: ReadonlySet<number> = new Set();
  let basePitch = 0.5;
  let yaw: number | null = null;
  let pitch: number | null = null;
  let prev: { yaw: number; pitch: number } | null = null;
  let steady = 0;
  let circleAt = 0;
  const kept = new Map<EnrollShot, { motion: number; at: number; turn: number }>();
  let pending: {
    shot: EnrollShot;
    motion: number;
    at: number;
    pitch: number;
    turn: number;
  } | null = null;

  const light = (add: number[]) => {
    if (add.every((i) => lit.has(i))) return;
    const next = new Set(lit);
    for (const i of add) next.add(i);
    lit = next;
  };
  const out = (guide: RingGuide | null, grab: EnrollShot | null = null, now = 0): RingStep => ({
    stage,
    guide,
    grab,
    lit,
    slow: stage === 'circle' && now - circleAt > RING_LINES.slowHintMs,
  });

  return {
    step(r: RingReading, now: number): RingStep {
      pending = null;
      if (stage === 'over') return out(null);
      if (r.count === 0 || r.yaw === null || r.pitch === null) {
        prev = null;
        yaw = pitch = null;
        steady = 0;
        return out(stage === 'circle' ? null : 'noFace', null, now);
      }
      if (r.count > 1) {
        steady = 0;
        return out('manyFaces', null, now);
      }
      // Movement since the last frame, in full turns, before smoothing.
      const motion = prev
        ? Math.hypot((r.yaw - prev.yaw) / YAW_FULL, (r.pitch - prev.pitch) / PITCH_FULL)
        : Infinity;
      prev = { yaw: r.yaw, pitch: r.pitch };
      const k = RING_LINES.smooth;
      yaw = yaw === null ? r.yaw : yaw + k * (r.yaw - yaw);
      pitch = pitch === null ? r.pitch : pitch + k * (r.pitch - pitch);
      if (r.size !== null && r.size < RING_LINES.minSize) {
        steady = 0;
        return out('closer', null, now);
      }

      if (stage === 'position' || stage === 'final') {
        let guide: RingGuide | null = null;
        if (
          r.cx !== null &&
          r.cy !== null &&
          (Math.abs(r.cx - 0.5) > RING_LINES.centerX || Math.abs(r.cy - 0.5) > RING_LINES.centerY)
        )
          guide = 'center';
        else if (Math.abs(r.yaw) > RING_LINES.straight) guide = 'lookStraight';
        steady = guide === null && motion <= RING_LINES.steady ? steady + 1 : 0;
        if (steady < RING_LINES.steadyFrames) return out(guide, null, now);
        const shot = stage === 'position' ? 'front' : 'front2';
        pending = { shot, motion, at: now, pitch, turn: 0 };
        return out(null, shot, now);
      }

      // The circle.
      const d = headDirection(yaw, pitch, basePitch);
      if (d.reach >= REACH) light(ticksNear(d.angle, RING_LINES.pointer));
      const pose = poseAt(d);
      if (pose && motion !== Infinity) {
        const had = kept.get(pose);
        const turn = Math.abs(d.x);
        const due = !had || now - had.at >= RING_LINES.regrabMs;
        // The sides carry the server's turn check: the furthest turn is
        // kept (2026-11-07). The others: the steadiest frame.
        const better =
          !had ||
          (due &&
            (pose === 'left' || pose === 'right'
              ? turn > had.turn + 0.1 && motion <= RING_LINES.steady * 3
              : motion < had.motion * 0.6));
        if (better) {
          pending = { shot: pose, motion, at: now, pitch, turn };
          return out(null, pose, now);
        }
      }
      const all = RING.every((x) => kept.has(x.pose));
      const enough = now - circleAt > RING_LINES.giveUpMs && kept.has('left') && kept.has('right');
      if (all || enough) {
        lit = new Set(Array.from({ length: TICKS }, (_, i) => i));
        stage = 'final';
        steady = 0;
      }
      return out(null, null, now);
    },

    /** The frame asked for by the last step was kept. */
    took(shot: EnrollShot) {
      if (!pending || pending.shot !== shot) return;
      kept.set(shot, { motion: pending.motion, at: pending.at, turn: pending.turn });
      if (shot === 'front') {
        basePitch = pending.pitch;
        stage = 'circle';
        circleAt = pending.at;
      } else if (shot === 'front2') {
        stage = 'over';
      }
      pending = null;
    },

    get stage() {
      return stage;
    },
  };
}
