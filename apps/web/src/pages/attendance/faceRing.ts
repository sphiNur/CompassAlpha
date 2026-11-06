/**
 * The Face ID-style enrollment ring (2026-11-06): where the head points,
 * as seen on the mirrored preview, and which ticks of the ring it lights.
 *
 * The tracker gives yaw (positive = turned to the person's own left) and
 * pitch (the nose between eyes and mouth; smaller with the chin up). On
 * the mirrored preview the person's own right is the screen's right, so
 * screen x = -yaw and screen y (up) = straight-on pitch - pitch. Pitch
 * moves less than yaw for the same head movement, so each is scaled to
 * "a full turn" before they are combined.
 */

/** Ticks around the ring. */
export const TICKS = 60;
/** A full turn sideways (the server wants 0.2; the punch camera waits for 0.35). */
export const YAW_FULL = 0.35;
/** A full tilt up or down, in pitch units. */
export const PITCH_FULL = 0.1;

export type RingPose =
  | 'right'
  | 'upright'
  | 'up'
  | 'upleft'
  | 'left'
  | 'downleft'
  | 'down'
  | 'downright';

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
 * to one of the eight. The sides need a full sideways turn (the server
 * checks them for liveness); the others a full reach overall.
 */
export function poseAt(d: HeadDirection): RingPose | null {
  if (d.reach < 1) return null;
  const hit = RING.find((r) => gap(r.angle, d.angle) <= 20);
  if (!hit) return null;
  if ((hit.pose === 'left' || hit.pose === 'right') && Math.abs(d.x) < 1) return null;
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
