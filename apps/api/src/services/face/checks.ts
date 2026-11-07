/**
 * When a punch needs the head turns, and whose face a photo is
 * (owner decisions 2026-11-06; stores have no fixed clock device, so
 * people clock on their own phones and every punch should stay quick).
 *
 * Turns are asked for on a risk signal (borrowed phone, new phone, no or
 * outside location, a face or real-face score near its line) or a 1-in-3
 * spot check. The spot check is a keyed hash of the person, the day and
 * how many punches they made that day: asking again gives the same
 * answer, and nobody can tell in advance which punch it falls on.
 */
import { createHmac } from 'node:crypto';
import { env } from '../../env';
import { bestScore } from './enroll';
import { MATCH_THRESHOLD } from './index';

/** One punch in this many gets the turns anyway. */
export const SPOT_CHECK_EVERY = 3;

export function spotCheck(memberId: string, date: string, punchesToday: number): boolean {
  const mac = createHmac('sha256', env.JWT_SECRET)
    .update(`attendance-spot:${memberId}|${date}|${punchesToday}`)
    .digest();
  return mac.readUInt32BE(0) % SPOT_CHECK_EVERY === 0;
}

export const CHECK_LINES = {
  /** A face this close to the match line is confirmed with turns. */
  faceGray: [0.3, 0.45] as const,
  /** Real-face score below this, without turns, asks for turns. */
  realSure: 0.8,
  /** Identification: the best face beats the next one by this much. */
  identifyMargin: 0.05,
  /**
   * Identification among colleagues needs more than one person's match
   * line (2026-11-07): the best of many faces crosses it more easily.
   */
  identifyMin: 0.45,
  /**
   * A movement frame (blink, open mouth, a turn) against the person's
   * enrollment: closed eyes, an open mouth or a turned head match less
   * well than the straight frame, but a different person stays far below.
   */
  moveMatch: 0.3,
  /** A frame this close to one seen before is the same picture sent again. */
  samePicture: 0.9995,
} as const;

export function faceInGrayZone(score: number): boolean {
  return score >= CHECK_LINES.faceGray[0] && score < CHECK_LINES.faceGray[1];
}

export interface KnownFace {
  memberId: string;
  name: string;
  /** The person's enrolled features; the best match counts. */
  features: readonly (readonly number[])[];
}

/**
 * The person a face belongs to among `known`, or null: the best match
 * over the match line and clearly ahead of the runner-up.
 */
export function identify(
  feature: readonly number[],
  known: readonly KnownFace[],
  line: number = MATCH_THRESHOLD,
): { memberId: string; name: string; score: number } | null {
  const ranked = known
    .map((k) => ({
      memberId: k.memberId,
      name: k.name,
      score: bestScore(k.features, feature) ?? -1,
    }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || !(best.score >= line)) return null;
  const next = ranked[1];
  if (next && !(best.score - next.score >= CHECK_LINES.identifyMargin)) return null;
  return best;
}

/** Every movement frame is the enrolled person too, not only the straight one. */
export function movesMatch(
  enrolled: readonly (readonly number[])[],
  moves: readonly (readonly number[])[],
): boolean {
  return moves.every((m) => (bestScore(enrolled, m) ?? -1) >= CHECK_LINES.moveMatch);
}

/** Whether any of `frames` is (nearly) the same picture as one in `seen`. */
export function samePicture(
  frames: readonly (readonly number[])[],
  seen: readonly (readonly number[])[],
): boolean {
  return frames.some((f) => (bestScore(seen, f) ?? -1) > CHECK_LINES.samePicture);
}
