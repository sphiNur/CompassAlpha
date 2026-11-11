/**
 * The sign-in state machine behind AuthGate: the session, the automatic
 * sign-in from Telegram (or the development login), the invite in the
 * launch link, and the actions the sign-in screen offers.
 *
 * Strategy (M1 hardened):
 *
 *  - On first mount, if we have no session AND haven't tried logging in yet,
 *    fire `auth.telegramLogin` exactly once. We use a ref to guard so an
 *    UNAUTHORIZED response from `auth.me` doesn't kick off a second login —
 *    the previous version did and produced a thundering loop in prod when
 *    the access token was rejected (signature mismatch / stale persist).
 *  - If the existing accessToken is rejected by `auth.me`, we treat it as
 *    "stale token, re-login on next manual sign-in" — clear() drops the
 *    persisted token but DOES NOT trigger another auto-login. The user gets
 *    a "Sign in" button and we wait for an explicit press.
 *  - If `auth.telegramLogin` itself fails, we surface the error and stop.
 *    No retries.
 *
 * Review COREWEB1-09 (2026-11-12): out of AuthGate.tsx. The five sign-in
 * mutations share one success step (`signedIn`), the two "busy" checks are
 * pure functions (signInPhase.ts), and every sign-in failure is read by
 * errorTextKey: the development and browser logins said "sign-in failed"
 * when the connection dropped.
 */
import { useEffect, useRef, useState } from 'react';
import { useToast } from '@compass/ui';
import { useAuthStore, type AuthSession } from '../../stores/authStore';
import { noteSessionCleared, trpc } from '../../lib/trpc';
import { getTg } from '../../lib/telegram';
import { useI18n } from '../../hooks/useI18n';
import { STALE } from '../../config/timings';
import { errorTextKey, isErrorKey, withoutFinalStop } from '../../lib/errorText';
import { isLikelyNetworkError } from '../../lib/networkError';
import { markInviteSettled } from '../../lib/launchInvite';
import { authErrorText, type AuthError } from '../../lib/authAccess';
import {
  devAsFromUrl,
  dropInviteFromAddressBar,
  inviteTokenFromLaunch,
  rememberDevBrowserTgUserId,
  shouldUseDevBypassLogin,
  wantsDevPersonaPicker,
} from './launch';
import { showSignInSpinner, signInInFlight } from './signInPhase';

const AUTH_WAIT_TIMEOUT_MS = 10_000;

/** What every sign-in mutation answers with. */
interface SignInResult {
  tokens: { accessToken: string; refreshToken: string };
  session: AuthSession;
}

export function useSignIn() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const session = useAuthStore((s) => s.session);
  const authHydrated = useAuthStore((s) => s.hasHydrated);
  const setSession = useAuthStore((s) => s.setSession);
  const clear = useAuthStore((s) => s.clear);
  const i18n = useI18n();
  const toast = useToast();
  const [error, setError] = useState<AuthError | null>(null);
  const [loginSession, setLoginSession] = useState<AuthSession | null>(null);
  const [authWaitTimedOut, setAuthWaitTimedOut] = useState(false);
  const [inviteToken, setInviteToken] = useState(inviteTokenFromLaunch);
  const activeSession = session ?? loginSession;
  const hasTelegramInitData = Boolean(getTg()?.initData);
  const forceDevPersonaPicker = wantsDevPersonaPicker();
  // A development build opened in a plain browser cannot sign in through
  // Telegram, so it goes straight to the persona picker (unless the
  // VITE_DEV_MOCK_INIT_DATA auto-login is configured).
  const devBrowser = import.meta.env.DEV && !hasTelegramInitData && !shouldUseDevBypassLogin();
  const [devAs] = useState(devAsFromUrl);
  /** True once `?devAs=` has picked its persona this mount cycle. */
  const devAsAttempted = useRef(false);
  /** True once we've issued a telegramLogin call this mount cycle. */
  const loginAttempted = useRef(false);
  /** True once we've tried to accept the launch invite this mount cycle. */
  const inviteAttempted = useRef(false);
  /** True once `auth.me` failed with UNAUTHORIZED — don't auto-login again. */
  const meUnauthorized = useRef(false);

  const me = trpc.auth.me.useQuery(undefined, {
    // An invite launch may deliberately switch organisations. The
    // existing access token belongs to the old session, so `me` must
    // not race the acceptance and overwrite the new one.
    enabled: authHydrated && !!accessToken && !inviteToken,
    retry: false,
  });
  const loginModes = trpc.auth.loginModes.useQuery(undefined, {
    enabled: authHydrated && !activeSession,
    retry: false,
    staleTime: STALE.short,
  });
  const showDevPersonas = Boolean(
    !activeSession &&
    !hasTelegramInitData &&
    loginModes.data?.devPersona.available &&
    (forceDevPersonaPicker || devBrowser || authWaitTimedOut || error),
  );
  const devPersonas = trpc.auth.devPersonas.useQuery(undefined, {
    enabled: authHydrated && showDevPersonas,
    retry: false,
    staleTime: STALE.short,
  });

  // If an existing token is bad, drop it. In Telegram Mini App we can
  // immediately re-login from initData; outside Telegram, keep the
  // manual sign-in fallback.
  useEffect(() => {
    if (!me.isError) return;
    const code = (me.error as { data?: { code?: string } } | undefined)?.data?.code;
    if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') {
      const hasTelegramInitData = Boolean(getTg()?.initData);
      const canAutoLogin = hasTelegramInitData || shouldUseDevBypassLogin();
      meUnauthorized.current = !canAutoLogin;
      if (canAutoLogin) loginAttempted.current = false;
      setLoginSession(null);
      noteSessionCleared('me-rejected');
      clear();
    }
  }, [me.isError, me.error, clear]);

  /**
   * Tokens are the source of truth for "am I logged in".
   *
   * 2026-07-30. `activeSession` is `session ?? loginSession`: the first
   * lives in the auth store, the second is React state here. `authFetch`
   * clears the STORE from outside this component whenever it meets a 401
   * it cannot refresh — and that 401 almost always comes from a page
   * query (catalog.skus, order.pendingList, run.get…), not from auth.me.
   *
   * When that happened, `session` went null but `loginSession` kept its
   * stale copy, so `activeSession` stayed truthy and we rendered the
   * Shell over a session with no tokens. Every query then failed
   * UNAUTHORIZED; `me` could not rescue it because its `enabled` reads
   * `!!accessToken`, so with the token gone the query was DISABLED, not
   * errored — and the effect above, the only thing that clears
   * `loginSession` and re-arms `loginAttempted`, never ran. The result
   * was the app frame rendering over an empty body forever, recoverable
   * only by wiping localStorage — which a user inside Telegram cannot do.
   *
   * So: no access token means no session, whatever `loginSession` still
   * remembers. Dropping it lets `activeSession` fall to null, which lets
   * the auto-login effect below re-run — silent re-login from initData in
   * Telegram, and the real sign-in screen (not a blank page) anywhere else.
   */
  useEffect(() => {
    if (!authHydrated) return;
    if (accessToken) return;
    if (!loginSession) return;
    setLoginSession(null);
    loginAttempted.current = false;
    meUnauthorized.current = false;
  }, [authHydrated, accessToken, loginSession]);

  // Refresh session in store when auth.me succeeds.
  useEffect(() => {
    if (!me.data) return;
    const at = useAuthStore.getState().accessToken;
    const rt = useAuthStore.getState().refreshToken;
    if (!at || !rt) return;
    setSession({ accessToken: at, refreshToken: rt, session: me.data });
    setLoginSession(me.data);
  }, [me.data, setSession]);

  /** The step every successful sign-in takes. */
  const signedIn = (data: SignInResult) => {
    setSession({
      accessToken: data.tokens.accessToken,
      refreshToken: data.tokens.refreshToken,
      session: data.session,
    });
    setLoginSession(data.session);
    meUnauthorized.current = false;
    setAuthWaitTimedOut(false);
    setError(null);
  };
  /**
   * A failed sign-in, in words. AUTH-21 (2026-10-30): a transport failure
   * showed its English text ("Failed to fetch (session refresh did not
   * complete)").
   */
  const signInFailed = (err: { message: string }) =>
    setError({ key: errorTextKey(err.message, 'auth.errors.signInFailed') });

  const login = trpc.auth.telegramLogin.useMutation({
    onSuccess: signedIn,
    onError: signInFailed,
  });
  const acceptInvite = trpc.auth.acceptInvite.useMutation({
    onSuccess(data, vars) {
      markInviteSettled(vars.token);
      // Done: `auth.me` checks the new session again from here on.
      setInviteToken(null);
      // AUTH-28 (2026-10-30): say what the invite did.
      toast.success(
        i18n.t(data.alreadyMember ? 'auth.invite.addedToExisting' : 'auth.invite.joined', {
          org: data.session.member.orgName,
        }),
      );
      signedIn(data);
      dropInviteFromAddressBar();
    },
    onError(err, vars) {
      // Refused by the server: a reload must not ask again. A failure to
      // get through is left for a reload or the retry button.
      if (!isLikelyNetworkError(err)) markInviteSettled(vars.token);
      // AUTH-3 (2026-10-30): a malformed invite token (a truncated link,
      // stray characters) failed input validation and the raw Zod JSON
      // was shown. Never show a raw message: a server key is translated,
      // a rejected token reads as an invalid link, the rest is generic.
      const code = (err as { data?: { code?: string } }).data?.code;
      const key = isErrorKey(err.message)
        ? err.message
        : code === 'BAD_REQUEST'
          ? 'auth.errors.inviteNotFound'
          : isLikelyNetworkError(err)
            ? 'common.networkError'
            : 'auth.errors.signInFailed';
      setError({ key });
      const message = authErrorText(i18n, { key });
      // AUTH-2 (2026-10-30): with a session already on the device the
      // error banner (sign-in screen only) never shows, and the person
      // landed in their old workspace believing they had joined.
      if (session) {
        toast.error(
          i18n.t('auth.invite.failedStillIn', {
            reason: withoutFinalStop(message),
            org: session.member.orgName,
          }),
        );
      }
    },
  });
  const devBypassLogin = trpc.auth.devBypassLogin.useMutation({
    onSuccess: signedIn,
    onError: signInFailed,
  });
  const nonTelegramLogin = trpc.auth.nonTelegramLogin.useMutation({
    onSuccess(data, vars) {
      signedIn(data);
      rememberDevBrowserTgUserId(vars.tgUserId);
    },
    onError: signInFailed,
  });
  const devPersonaLogin = trpc.auth.devPersonaLogin.useMutation({
    onSuccess: signedIn,
    onError: signInFailed,
  });

  // `?devAs=` names who should be signed in: a session for someone else is
  // dropped first, so changing the URL switches persona in the same tab.
  useEffect(() => {
    if (!devAs || !authHydrated || devAsAttempted.current || !activeSession) return;
    const name = activeSession.user.displayName?.toLowerCase() ?? '';
    if (activeSession.member.memberId === devAs || name.includes(devAs)) {
      devAsAttempted.current = true;
      return;
    }
    clear();
  }, [devAs, authHydrated, activeSession, clear]);

  useEffect(() => {
    if (!devAs || devAsAttempted.current || activeSession || !devPersonas.data) return;
    const personas = devPersonas.data;
    const match =
      personas.find((p) => p.memberId === devAs) ??
      personas.find((p) => p.displayName.toLowerCase().includes(devAs));
    devAsAttempted.current = true;
    if (match) devPersonaLogin.mutate({ memberId: match.memberId });
    else setError({ key: 'auth.errors.signInFailed', raw: `devAs: no persona matches "${devAs}"` });
  }, [devAs, activeSession, devPersonas.data, devPersonaLogin]);

  const autoLoginData = getTg()?.initData ?? (shouldUseDevBypassLogin() ? 'dev-bypass' : null);

  const flags = {
    authHydrated,
    hasSession: Boolean(activeSession),
    hasError: Boolean(error),
    hasAccessToken: Boolean(accessToken),
    timedOut: authWaitTimedOut,
    devBrowser,
    hasAutoLoginData: Boolean(autoLoginData),
    telegramLogin: { pending: login.isPending, failed: login.isError },
    devBypass: { pending: devBypassLogin.isPending, failed: devBypassLogin.isError },
    invitePending: acceptInvite.isPending,
    browserLoginPending: nonTelegramLogin.isPending,
    personaPending: devPersonaLogin.isPending,
    meLoading: me.isLoading,
    loginModesLoading: loginModes.isLoading,
    personasLoading: devPersonas.isLoading,
  };
  const inFlight = signInInFlight(flags);

  // What the sign-in is doing, for a developer's console. Review
  // COREWEB1-09: written after each render, not during it.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as Window & { __compassAuthDebug?: Record<string, unknown> }).__compassAuthDebug = {
      authHydrated,
      hasAccessToken: Boolean(accessToken),
      hasStoreSession: Boolean(session),
      hasLoginSession: Boolean(loginSession),
      hasActiveSession: Boolean(activeSession),
      loginPending: login.isPending,
      devBypassPending: devBypassLogin.isPending,
      personaPending: devPersonaLogin.isPending,
      meLoading: me.isLoading,
      loginModesLoading: loginModes.isLoading,
      hasAutoLoginData: Boolean(autoLoginData),
      error,
      authWaitTimedOut,
    };
  });

  useEffect(() => {
    if (!inFlight) {
      setAuthWaitTimedOut(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setAuthWaitTimedOut(true);
    }, AUTH_WAIT_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [inFlight]);

  // Auto-login exactly once per mount, gated by ref so UNAUTHORIZED on me
  // can't restart the cycle.
  useEffect(() => {
    if (!authHydrated) return;
    const initData = getTg()?.initData;
    if (inviteToken && initData && !inviteAttempted.current) {
      inviteAttempted.current = true;
      loginAttempted.current = true;
      acceptInvite.mutate({ initData, token: inviteToken, locale: i18n.locale });
      return;
    }
    if (activeSession) return;
    if (loginAttempted.current) return;
    // AUTH-13 (2026-10-30): a rejected token re-arms `loginAttempted` from
    // the auth.me error effect, which could fire again while the first
    // telegramLogin was still in flight — two logins, two refresh chains.
    if (login.isPending || devBypassLogin.isPending) return;
    if (meUnauthorized.current && !getTg()?.initData) return;
    if (accessToken) return; // there's a token, let auth.me decide its fate first
    const tg = getTg();
    const autoInitData = tg?.initData;
    if (shouldUseDevBypassLogin()) {
      loginAttempted.current = true;
      devBypassLogin.mutate();
      return;
    }
    if (!autoInitData) return;
    loginAttempted.current = true;
    login.mutate({ initData: autoInitData });
  }, [
    authHydrated,
    activeSession,
    accessToken,
    acceptInvite,
    devBypassLogin,
    i18n.locale,
    inviteToken,
    login,
  ]);

  return {
    /** Nothing to ask yet: AuthGate draws a spinner. */
    waiting: showSignInSpinner(flags),
    activeSession,
    error,
    authWaitTimedOut,
    hasTelegramInitData,
    loginModes: { data: loginModes.data, error: loginModes.error?.message },
    showDevPersonas,
    devPersonas: {
      list: devPersonas.data ?? [],
      loading: devPersonas.isLoading,
      error: devPersonas.error?.message ?? null,
    },
    personaPending: devPersonaLogin.isPending,
    browserLoginPending: nonTelegramLogin.isPending,
    /** The launch invite failed inside Telegram: it can be tried again. */
    canRetryInvite: Boolean(inviteToken && hasTelegramInitData && error),
    signInWithTelegram: () => {
      loginAttempted.current = true;
      meUnauthorized.current = false;
      setError(null);
      if (shouldUseDevBypassLogin()) {
        devBypassLogin.mutate();
        return;
      }
      const data = getTg()?.initData ?? '';
      if (!data) {
        setError({ key: 'auth.errors.noInitData' });
        return;
      }
      login.mutate({ initData: data });
    },
    retryInvite: () => {
      const initData = getTg()?.initData;
      if (!initData || !inviteToken) return;
      setError(null);
      inviteAttempted.current = false;
      acceptInvite.mutate({ initData, token: inviteToken, locale: i18n.locale });
    },
    signInAsPersona: (memberId: string) => {
      setError(null);
      devPersonaLogin.mutate({ memberId });
    },
    signInDevAuto: () => {
      setError(null);
      loginAttempted.current = true;
      devBypassLogin.mutate();
    },
    signInInBrowser: (tgUserId: string, accessCode: string) => {
      setError(null);
      nonTelegramLogin.mutate({ tgUserId, accessCode, locale: i18n.locale });
    },
  };
}

export type SignIn = ReturnType<typeof useSignIn>;
