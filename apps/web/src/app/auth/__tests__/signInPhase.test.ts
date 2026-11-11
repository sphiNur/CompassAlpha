/**
 * Review COREWEB1-09 (2026-11-12): AuthGate's two "busy" checks, moved out
 * of the component as they were. These pin where they differ.
 */
import { describe, expect, test } from 'bun:test';
import { showSignInSpinner, signInInFlight, type SignInFlags } from '../signInPhase';

const idle: SignInFlags = {
  authHydrated: true,
  hasSession: false,
  hasError: false,
  hasAccessToken: false,
  timedOut: false,
  devBrowser: false,
  hasAutoLoginData: false,
  telegramLogin: { pending: false, failed: false },
  devBypass: { pending: false, failed: false },
  invitePending: false,
  browserLoginPending: false,
  personaPending: false,
  meLoading: false,
  loginModesLoading: false,
  personasLoading: false,
};
const flags = (over: Partial<SignInFlags>): SignInFlags => ({ ...idle, ...over });

describe('showSignInSpinner', () => {
  test('nothing is under way: the sign-in screen, no spinner', () => {
    expect(showSignInSpinner(idle)).toBe(false);
    expect(signInInFlight(idle)).toBe(false);
  });

  test('the stored session is not read yet', () => {
    expect(showSignInSpinner(flags({ authHydrated: false }))).toBe(true);
  });

  test('Telegram sign-in about to start or running', () => {
    expect(showSignInSpinner(flags({ hasAutoLoginData: true }))).toBe(true);
    const running = flags({ telegramLogin: { pending: true, failed: false } });
    expect(showSignInSpinner(running)).toBe(true);
    expect(signInInFlight(running)).toBe(true);
  });

  test('a failed sign-in shows the screen, though the observer may still say pending', () => {
    expect(showSignInSpinner(flags({ hasAutoLoginData: true, hasError: true }))).toBe(false);
    const stuck = flags({ hasError: true, telegramLogin: { pending: true, failed: false } });
    expect(showSignInSpinner(stuck)).toBe(false);
    expect(signInInFlight(stuck)).toBe(false);
    expect(
      showSignInSpinner(
        flags({ hasAutoLoginData: true, telegramLogin: { pending: false, failed: true } }),
      ),
    ).toBe(false);
  });

  test('after the wait times out: the screen, with its "taking long" note', () => {
    const slow = flags({ timedOut: true, telegramLogin: { pending: true, failed: false } });
    expect(showSignInSpinner(slow)).toBe(false);
    expect(signInInFlight(slow)).toBe(true);
  });

  test('an invite being accepted spins even over a session; it is not "in flight" then', () => {
    const switching = flags({ hasSession: true, invitePending: true });
    expect(showSignInSpinner(switching)).toBe(true);
    expect(signInInFlight(switching)).toBe(false);
  });

  test('the browser login and the persona list have their own spinners on the screen', () => {
    const browser = flags({ browserLoginPending: true });
    expect(showSignInSpinner(browser)).toBe(false);
    expect(signInInFlight(browser)).toBe(true);
    const personas = flags({ personasLoading: true });
    expect(showSignInSpinner(personas)).toBe(false);
    expect(signInInFlight(personas)).toBe(true);
  });

  test('a development browser waits for the login modes, error or not', () => {
    const waiting = flags({ devBrowser: true, loginModesLoading: true, hasError: true });
    expect(showSignInSpinner(waiting)).toBe(true);
    expect(showSignInSpinner(flags({ loginModesLoading: true }))).toBe(false);
  });

  test('a stored token being checked', () => {
    const checking = flags({ hasAccessToken: true, meLoading: true });
    expect(showSignInSpinner(checking)).toBe(true);
    expect(signInInFlight(checking)).toBe(true);
    // Signed in already: the app draws over the check.
    expect(showSignInSpinner({ ...checking, hasSession: true })).toBe(false);
  });
});
