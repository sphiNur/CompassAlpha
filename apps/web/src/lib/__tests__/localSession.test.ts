/**
 * Review COREWEB1-16 (2026-11-12): the crash screen and the debug page's
 * sign-out clear the same things, through clearLocalSession.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { testSession } from '../../__tests__/fixtures/session';
import { memoryStorage } from '../../__tests__/helpers/storage';
import { AUTH_STORAGE_KEY, useAuthStore } from '../../stores/authStore';
import { NAV_STORAGE_KEY } from '../../stores/navStore';
import { clearLocalSession, SAVED_SESSION_KEYS } from '../localSession';

const g = globalThis as { window?: unknown };
const realWindow = g.window;

afterEach(() => {
  g.window = realWindow;
  useAuthStore.setState({ accessToken: null, refreshToken: null, session: null });
});

describe('clearLocalSession', () => {
  it('removes the saved sign-in and tab, and nothing else', async () => {
    const local = memoryStorage({
      [AUTH_STORAGE_KEY]: '{}',
      [NAV_STORAGE_KEY]: '{}',
      'compass.theme': 'dark',
    });
    const session = memoryStorage({ 'compass.inviteSettled': 'token' });
    g.window = { localStorage: local, sessionStorage: session };
    await clearLocalSession();
    expect([...local.map.keys()]).toEqual(['compass.theme']);
    // The launch's one-time markers: an accepted invite stays accepted.
    expect(session.getItem('compass.inviteSettled')).toBe('token');
  });

  it('signs out in memory first, so the saved sign-in is not written back', async () => {
    const local = memoryStorage({});
    g.window = { localStorage: local, sessionStorage: memoryStorage({}) };
    useAuthStore.setState({ accessToken: 'a', refreshToken: 'r', session: testSession() });
    // What the store's persistence does on every change.
    const unsubscribe = useAuthStore.subscribe(() => local.setItem(AUTH_STORAGE_KEY, 'saved'));
    await clearLocalSession();
    unsubscribe();
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().refreshToken).toBeNull();
    expect(local.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it('names the stores’ own keys', () => {
    expect(SAVED_SESSION_KEYS).toEqual([AUTH_STORAGE_KEY, NAV_STORAGE_KEY]);
  });
});
