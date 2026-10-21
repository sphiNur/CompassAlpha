import { describe, expect, test } from 'bun:test';
import type { AuthSession } from '../../stores/authStore';
import { applyRefreshedSession } from '../refreshSession';

function sink(accessToken: string | null) {
  const patched: AuthSession[] = [];
  return {
    patched,
    getState: () => ({ accessToken, patchSession: (s: AuthSession) => void patched.push(s) }),
  };
}

const session = {
  stores: [{ id: 's1', name: 'New', code: null, isActive: true }],
} as unknown as AuthSession;

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
