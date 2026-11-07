import { describe, expect, test } from 'bun:test';
import { punchOutcome, refusalHint } from './punchOutcome';

/** A tRPC error as the client sees it: the key as message, placeholders in data.context. */
const refused = (message: string, context?: Record<string, unknown>) =>
  Object.assign(new Error(message), { data: context ? { context } : {} });

describe('punch outcome', () => {
  test('no answer: the same punch again', () => {
    expect(punchOutcome(new TypeError('Failed to fetch (timed out)'), 'in')).toEqual({
      next: 'resend',
    });
    expect(punchOutcome(new TypeError('Failed to fetch (gateway 502)'), 'in')).toEqual({
      next: 'resend',
    });
    expect(punchOutcome(refused('common.errors.requestInFlight'), null)).toEqual({
      next: 'resend',
    });
  });

  test('the server wants more: the turns, a fresh challenge, a reason', () => {
    expect(punchOutcome(refused('attendance.errors.livenessNeeded'), 'in').next).toBe('turns');
    expect(punchOutcome(refused('attendance.errors.livenessExpired'), 'in').next).toBe('restart');
    expect(
      punchOutcome(
        refused('attendance.errors.overtimeReasonRequired', { minutes: 45, name: 'Bob' }),
        null,
      ),
    ).toEqual({ next: 'reason', minutes: 45, name: 'Bob' });
    expect(
      punchOutcome(refused('attendance.errors.overtimeReasonRequired', { minutes: 40 }), 'out'),
    ).toEqual({ next: 'reason', minutes: 40, name: null });
  });

  test('recorded before: shown as done, not as an error', () => {
    expect(
      punchOutcome(
        refused('attendance.errors.justPunched', { lastKind: 'in', time: '09:02', name: 'Bob' }),
        null,
      ),
    ).toEqual({ next: 'already', kind: 'in', time: '09:02', name: 'Bob' });
    // Asked for a clock-in, and the last punch there is that clock-in.
    expect(
      punchOutcome(
        refused('attendance.errors.alreadyClockedIn', { lastKind: 'in', time: '09:02' }),
        'in',
      ),
    ).toEqual({ next: 'already', kind: 'in', time: '09:02', name: null });
  });

  test('a kind conflict that is not a repeat stays an error', () => {
    // Asked for a clock-out, but the last punch is an old clock-in (open too long).
    const out = punchOutcome(
      refused('attendance.errors.notClockedIn', { lastKind: 'in', time: '08:00' }),
      'out',
    );
    expect(out.next).toBe('stop');
    expect(punchOutcome(refused('attendance.errors.notClockedIn'), 'out').next).toBe('stop');
  });

  test('a refused face: another try, with what to do', () => {
    const out = punchOutcome(refused('attendance.errors.notRecognized'), null);
    expect(out).toEqual({ next: 'retry', key: 'attendance.errors.notRecognized' });
    expect(refusalHint('attendance.errors.notRecognized')).toBe(
      'attendance.punch.notRecognizedHint',
    );
    expect(refusalHint('attendance.errors.faceMismatch')).toBe('attendance.face.refusedBody');
    expect(punchOutcome(refused('attendance.errors.identifyIsOwner'), null).next).toBe('forSelf');
  });

  test('consent and enrollment go to their own sheets', () => {
    expect(punchOutcome(refused('attendance.errors.consentRequired'), 'in').next).toBe('consent');
    expect(punchOutcome(refused('attendance.errors.faceNotEnrolled'), 'in').next).toBe('enroll');
  });

  test('anything else: why, and close', () => {
    expect(
      punchOutcome(refused('attendance.errors.outsideArea', { distance: 350, radius: 150 }), 'in'),
    ).toEqual({
      next: 'stop',
      key: 'attendance.errors.outsideArea',
      vars: { distance: 350, radius: 150 },
    });
    expect(punchOutcome(new Error('something odd'), 'in')).toEqual({
      next: 'stop',
      key: 'attendance.errors.punchFailed',
      vars: {},
    });
  });
});
