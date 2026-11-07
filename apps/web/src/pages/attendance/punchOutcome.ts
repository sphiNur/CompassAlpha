/**
 * What the clock sheet does with a refused punch (owner, 2026-11-07).
 *
 * The punch goes out as soon as the last face frame is taken, with no
 * look at the photos first, so every answer is handled inside the sheet:
 * the next step (the head turns, an overtime reason), another try with
 * the reason why, or a stop. Kept free of React so it can be tested.
 */
import {
  errorTextOf,
  errorVars,
  isServerSideFailure,
  serverErrorKey,
  type ErrorVars,
} from '../../lib/errorText';
import { isLikelyNetworkError } from '../../lib/networkError';

export type PunchKind = 'in' | 'out';

/** The face did not pass: say why, and offer another try. */
const FACE_REFUSALS = new Set([
  'attendance.errors.livenessFailed',
  'attendance.errors.faceMismatch',
  'attendance.errors.faceNotFound',
  'attendance.errors.notRecognized',
  'attendance.errors.photoReused',
  'attendance.errors.borrowFaceMismatch',
  'attendance.errors.borrowNoFace',
  'attendance.errors.borrowNoConsent',
]);

export type PunchOutcome =
  /** The server wants the head turns this time: the same punch again, with them. */
  | { next: 'turns' }
  /** The challenge ran out (three minutes): a fresh one for the same punch. */
  | { next: 'restart' }
  /** A clock-out past the shift: the reason, then the same photos again. */
  | { next: 'reason'; minutes: number; name: string | null }
  | { next: 'consent' }
  | { next: 'enroll' }
  /** It is recorded already: an answer lost on the way, or a second try. */
  | { next: 'already'; kind: PunchKind; time: string; name: string | null }
  /** The face did not pass. */
  | { next: 'retry'; key: string }
  /** The phone's own face, in colleague mode. */
  | { next: 'forSelf'; key: string }
  /** The request did not get through or got no answer: the same punch again, same key. */
  | { next: 'resend' }
  /** Anything else: why, and close. */
  | { next: 'stop'; key: string; vars: ErrorVars };

/**
 * `attempted`: the kind the phone asked for (null: a colleague, whose
 * kind the server picks).
 */
export function punchOutcome(err: unknown, attempted: PunchKind | null): PunchOutcome {
  const key = serverErrorKey(err);
  const vars = errorVars(err);
  const text = (name: string) => (typeof vars[name] === 'string' ? (vars[name] as string) : null);
  if (!key) {
    const raw = (err as { message?: unknown } | null)?.message;
    if (isLikelyNetworkError(err) || isServerSideFailure(typeof raw === 'string' ? raw : undefined))
      return { next: 'resend' };
    const shown = errorTextOf(err, 'attendance.errors.punchFailed');
    return { next: 'stop', key: shown.key, vars: shown.vars };
  }
  switch (key) {
    // The same key is still being answered (a resend while the first runs).
    case 'common.errors.requestInFlight':
      return { next: 'resend' };
    case 'attendance.errors.livenessNeeded':
      return { next: 'turns' };
    case 'attendance.errors.livenessExpired':
      return { next: 'restart' };
    case 'attendance.errors.overtimeReasonRequired':
      return { next: 'reason', minutes: Number(vars.minutes ?? 0), name: text('name') };
    case 'attendance.errors.consentRequired':
      return { next: 'consent' };
    case 'attendance.errors.faceNotEnrolled':
      return { next: 'enroll' };
    case 'attendance.errors.identifyIsOwner':
      return { next: 'forSelf', key };
    case 'attendance.errors.justPunched': {
      const kind = vars.lastKind;
      const time = text('time');
      if ((kind === 'in' || kind === 'out') && time)
        return { next: 'already', kind, time, name: text('name') };
      return { next: 'stop', key, vars };
    }
    case 'attendance.errors.alreadyClockedIn':
    case 'attendance.errors.notClockedIn': {
      // The punch tried is the last one there: it went through before.
      const time = text('time');
      if (attempted && vars.lastKind === attempted && time)
        return { next: 'already', kind: attempted, time, name: null };
      return { next: 'stop', key, vars };
    }
  }
  if (FACE_REFUSALS.has(key)) return { next: 'retry', key };
  return { next: 'stop', key, vars };
}

/** The line under a refused face: what to do about it. */
export function refusalHint(key: string): string | null {
  if (key === 'attendance.errors.notRecognized') return 'attendance.punch.notRecognizedHint';
  if (
    key === 'attendance.errors.livenessFailed' ||
    key === 'attendance.errors.faceMismatch' ||
    key === 'attendance.errors.faceNotFound' ||
    key === 'attendance.errors.photoReused' ||
    key === 'attendance.errors.borrowFaceMismatch'
  )
    return 'attendance.face.refusedBody';
  return null;
}
