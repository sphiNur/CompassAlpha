import { describe, expect, test } from 'bun:test';
import { testSession } from '../../__tests__/fixtures/session';
import type { AuthSession } from '../../stores/authStore';
import { applyRefreshedSession } from '../refreshSession';

function sink(accessToken: string | null) {
  const patched: AuthSession[] = [];
  return {
    patched,
    getState: () => ({ accessToken, patchSession: (s: AuthSession) => void patched.push(s) }),
  };
}

const session = testSession({ stores: [{ id: 's1', name: 'New', code: null, isActive: true }] });

describe('applyRefreshedSession', () => {
  test('patches the session while signed in', () => {
    const s = sink('at');
    expect(applyRefreshedSession(session, s)).toBe(true);
    expect(s.patched).toEqual([session]);
  });

  test('does not resurrect a session after sign-out mid-flight', () => {
    const s = sink(null);
    expect(applyRefreshedSession(session, s)).toBe(false);
    expect(s.patched).toHaveLength(0);
  });

  test('ignores an empty result', () => {
    const s = sink('at');
    expect(applyRefreshedSession(undefined, s)).toBe(false);
    expect(s.patched).toHaveLength(0);
  });
});
