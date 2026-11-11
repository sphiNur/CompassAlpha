/**
 * The two questions AuthGate asks about sign-in while it is under way.
 * They read the same flags and answer differently on purpose:
 *
 * - {@link signInInFlight}: is any sign-in step still running? After
 *   AUTH_WAIT_TIMEOUT_MS of that, the sign-in screen says it is taking long
 *   (and, in development, why).
 * - {@link showSignInSpinner}: is there nothing to ask the person yet? Then
 *   AuthGate draws a spinner instead of the sign-in screen. A browser login
 *   or a persona list that is loading has its own spinner on that screen,
 *   so it does not count here. An invite being accepted does, even over a
 *   session, since it may switch the workspace.
 *
 * Review COREWEB1-09 (2026-11-12): both were inline boolean expressions in
 * AuthGate, close enough to look like copies and not the same.
 */

export interface SignInFlags {
  authHydrated: boolean;
  hasSession: boolean;
  hasError: boolean;
  hasAccessToken: boolean;
  /** The sign-in has been in flight for AUTH_WAIT_TIMEOUT_MS. */
  timedOut: boolean;
  /** A development build in a plain browser (no Telegram, no auto-login). */
  devBrowser: boolean;
  /** Telegram's initData, or the development auto-login, is there to use. */
  hasAutoLoginData: boolean;
  telegramLogin: { pending: boolean; failed: boolean };
  devBypass: { pending: boolean; failed: boolean };
  invitePending: boolean;
  browserLoginPending: boolean;
  personaPending: boolean;
  meLoading: boolean;
  loginModesLoading: boolean;
  personasLoading: boolean;
}

export function signInInFlight(f: SignInFlags): boolean {
  return (
    !f.hasSession &&
    !f.hasError &&
    (f.telegramLogin.pending ||
      f.devBypass.pending ||
      f.invitePending ||
      f.browserLoginPending ||
      f.personaPending ||
      (f.meLoading && f.hasAccessToken) ||
      f.loginModesLoading ||
      f.personasLoading)
  );
}

export function showSignInSpinner(f: SignInFlags): boolean {
  if (!f.authHydrated) return true;
  // Until the server says whether dev personas exist, a plain-browser dev
  // build would otherwise flash the Telegram sign-in screen.
  if (f.devBrowser && !f.hasSession && f.loginModesLoading) return true;
  // CMP-SHL-2 (2026-10-31): a request that already failed is never a
  // reason to keep spinning. The error is set from the mutation's own
  // onError, while `isPending` belongs to the observer, which can miss
  // that update (seen in development builds, where React mounts twice):
  // it said "pending" forever, and with the error set the 10 s fallback
  // never armed either.
  if (f.timedOut || f.hasError) return false;
  return (
    (f.telegramLogin.pending && !f.hasSession) ||
    f.invitePending ||
    (f.devBypass.pending && !f.hasSession) ||
    (f.personaPending && !f.hasSession) ||
    (f.meLoading && f.hasAccessToken && !f.hasSession) ||
    // About to sign in: the effect fires after this render.
    (!f.hasSession && f.hasAutoLoginData && !f.telegramLogin.failed && !f.devBypass.failed)
  );
}
