import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Banner, Input, Spinner, useToast } from '@compass/ui';
import { useAuthStore, type AuthSession } from '../stores/authStore';
import { noteSessionCleared, trpc } from '../lib/trpc';
import { getTg, haptic } from '../hooks/useTelegram';
import { useI18n, useRoleLabels } from '../hooks/useI18n';
import { useTranslateError } from '../lib/errToast';
import { errorTextKey, withoutFinalStop } from '../lib/errorText';
import { isLikelyNetworkError } from '../lib/networkError';
import { useRefreshSession } from '../lib/refreshSession';
import { accessBlock, authErrorText, type AuthError } from '../lib/authAccess';

interface AuthGateProps {
  children: ReactNode;
}

// A browser-development login already persists its refresh token. Remembering
// only the non-secret Telegram ID keeps the rare re-authentication path short
// without putting the access code in local storage or the client bundle.
const DEV_BROWSER_TG_USER_ID_KEY = 'compass.devBrowserTgUserId';
const DEV_LOGIN_MODE_KEY = 'compass.devLoginMode';
const AUTH_WAIT_TIMEOUT_MS = 10_000;

interface DevPersona {
  memberId: string;
  displayName: string;
  orgName: string;
  tgUserId: string | null;
  roleSlugs: string[];
  storeNames: string[];
  isAdmin: boolean;
  maxRank: number;
  permissionCount: number;
}

function wantsDevPersonaPicker(): boolean {
  if (!import.meta.env.DEV || typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    return (
      params.get('devLogin') === 'choose' ||
      window.localStorage.getItem(DEV_LOGIN_MODE_KEY) === 'choose'
    );
  } catch {
    return false;
  }
}

/**
 * `?devAs=<name or memberId>` signs a local development build straight in
 * as that persona (case-insensitive part of the display name), so test
 * scripts and repeated debugging skip the picker. Development builds only.
 */
function devAsFromUrl(): string | null {
  if (!import.meta.env.DEV || typeof window === 'undefined') return null;
  try {
    return new URLSearchParams(window.location.search).get('devAs')?.trim().toLowerCase() || null;
  } catch {
    return null;
  }
}

function shouldUseDevBypassLogin(): boolean {
  return (
    import.meta.env.DEV &&
    import.meta.env.VITE_DEV_MOCK_INIT_DATA === '1' &&
    typeof window !== 'undefined' &&
    !window.Telegram?.WebApp?.initData &&
    !wantsDevPersonaPicker()
  );
}

function initialDevBrowserTgUserId(): string {
  if (!import.meta.env.DEV || typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(DEV_BROWSER_TG_USER_ID_KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * The invite token arrives in one of two places depending on how the
 * recipient got here:
 *   - ?startapp=<token> on the bot link → initDataUnsafe.start_param
 *   - the bot's web_app fallback button → ?invite=<token> on our URL
 * Both are only useful inside Telegram, where a signed initData blob
 * is also present.
 */
function inviteTokenFromLaunch(): string | null {
  const startParam = getTg()?.initDataUnsafe?.start_param?.trim();
  if (startParam?.startsWith('inv_')) return startParam;
  if (typeof window === 'undefined') return null;
  const fromUrl = new URLSearchParams(window.location.search).get('invite')?.trim();
  return fromUrl || null;
}

/**
 * AuthGate strategy (M1 hardened):
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
 */
export function AuthGate({ children }: AuthGateProps) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const session = useAuthStore((s) => s.session);
  const authHydrated = useAuthStore((s) => s.hasHydrated);
  const setSession = useAuthStore((s) => s.setSession);
  const clear = useAuthStore((s) => s.clear);
  const i18n = useI18n();
  const toast = useToast();
  const [error, setError] = useState<AuthError | null>(null);
  const [browserTgUserId, setBrowserTgUserId] = useState(initialDevBrowserTgUserId);
  const [browserAccessCode, setBrowserAccessCode] = useState('');
  const [loginSession, setLoginSession] = useState<AuthSession | null>(null);
  const [authWaitTimedOut, setAuthWaitTimedOut] = useState(false);
  const [inviteToken] = useState(inviteTokenFromLaunch);
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
    staleTime: 30_000,
  });
  const shouldShowDevPersonas = Boolean(
    !activeSession &&
    !hasTelegramInitData &&
    loginModes.data?.devPersona.available &&
    (forceDevPersonaPicker || devBrowser || authWaitTimedOut || error),
  );
  const devPersonas = trpc.auth.devPersonas.useQuery(undefined, {
    enabled: authHydrated && shouldShowDevPersonas,
    retry: false,
    staleTime: 15_000,
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

  const login = trpc.auth.telegramLogin.useMutation({
    onSuccess(data) {
      setSession({
        accessToken: data.tokens.accessToken,
        refreshToken: data.tokens.refreshToken,
        session: data.session,
      });
      setLoginSession(data.session);
      meUnauthorized.current = false;
      setAuthWaitTimedOut(false);
      setError(null);
    },
    onError(err) {
      // AUTH-21 (2026-10-30): a transport failure showed its English text
      // ("Failed to fetch (session refresh did not complete)").
      setError({ key: errorTextKey(err.message, 'auth.errors.signInFailed') });
    },
  });
  const acceptInvite = trpc.auth.acceptInvite.useMutation({
    onSuccess(data) {
      // AUTH-28 (2026-10-30): say what the invite did.
      toast.success(
        i18n.t(data.alreadyMember ? 'auth.invite.addedToExisting' : 'auth.invite.joined', {
          org: data.session.member.orgName,
        }),
      );
      setSession({
        accessToken: data.tokens.accessToken,
        refreshToken: data.tokens.refreshToken,
        session: data.session,
      });
      setLoginSession(data.session);
      meUnauthorized.current = false;
      setAuthWaitTimedOut(false);
      setError(null);
      // The query-string form is visible in the address bar. Once the
      // invite has been accepted it has no job left.
      try {
        const url = new URL(window.location.href);
        if (url.searchParams.has('invite')) {
          url.searchParams.delete('invite');
          window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
        }
      } catch {
        /* the session is valid even if the URL cannot be rewritten */
      }
    },
    onError(err) {
      // AUTH-3 (2026-10-30): a malformed invite token (a truncated link,
      // stray characters) failed input validation and the raw Zod JSON
      // was shown. Never show a raw message: a server key is translated,
      // a rejected token reads as an invalid link, the rest is generic.
      const code = (err as { data?: { code?: string } }).data?.code;
      const key = /^[a-z]+\.errors?\./.test(err.message)
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
    onSuccess(data) {
      setSession({
        accessToken: data.tokens.accessToken,
        refreshToken: data.tokens.refreshToken,
        session: data.session,
      });
      setLoginSession(data.session);
      meUnauthorized.current = false;
      setAuthWaitTimedOut(false);
      setError(null);
    },
    onError(err) {
      setError({ key: err.message });
    },
  });
  const nonTelegramLogin = trpc.auth.nonTelegramLogin.useMutation({
    onSuccess(data) {
      setSession({
        accessToken: data.tokens.accessToken,
        refreshToken: data.tokens.refreshToken,
        session: data.session,
      });
      setLoginSession(data.session);
      if (import.meta.env.DEV && browserTgUserId.trim()) {
        try {
          window.localStorage.setItem(DEV_BROWSER_TG_USER_ID_KEY, browserTgUserId.trim());
        } catch {
          /* localStorage unavailable; the login session still works */
        }
      }
      meUnauthorized.current = false;
      setAuthWaitTimedOut(false);
      setError(null);
    },
    onError(err) {
      setError({ key: err.message });
    },
  });
  const devPersonaLogin = trpc.auth.devPersonaLogin.useMutation({
    onSuccess(data) {
      setSession({
        accessToken: data.tokens.accessToken,
        refreshToken: data.tokens.refreshToken,
        session: data.session,
      });
      setLoginSession(data.session);
      meUnauthorized.current = false;
      setAuthWaitTimedOut(false);
      setError(null);
    },
    onError(err) {
      setError({ key: err.message });
    },
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
    const personas = devPersonas.data as DevPersona[];
    const match =
      personas.find((p) => p.memberId === devAs) ??
      personas.find((p) => p.displayName.toLowerCase().includes(devAs));
    devAsAttempted.current = true;
    if (match) devPersonaLogin.mutate({ memberId: match.memberId });
    else setError({ key: 'auth.errors.signInFailed', raw: `devAs: no persona matches "${devAs}"` });
  }, [devAs, activeSession, devPersonas.data, devPersonaLogin]);

  const autoLoginData = getTg()?.initData ?? (shouldUseDevBypassLogin() ? 'dev-bypass' : null);

  if (import.meta.env.DEV && typeof window !== 'undefined') {
    (
      window as Window & {
        __compassAuthDebug?: Record<string, unknown>;
      }
    ).__compassAuthDebug = {
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
  }

  const authBusy =
    !activeSession &&
    !error &&
    ((login.isPending && !activeSession) ||
      devBypassLogin.isPending ||
      acceptInvite.isPending ||
      nonTelegramLogin.isPending ||
      devPersonaLogin.isPending ||
      (me.isLoading && !!accessToken) ||
      loginModes.isLoading ||
      devPersonas.isLoading);

  useEffect(() => {
    if (!authBusy) {
      setAuthWaitTimedOut(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setAuthWaitTimedOut(true);
    }, AUTH_WAIT_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [authBusy]);

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

  if (
    !authHydrated ||
    // Until the server says whether dev personas exist, a plain-browser dev
    // build would otherwise flash the Telegram sign-in screen.
    (devBrowser && !activeSession && loginModes.isLoading) ||
    // CMP-SHL-2 (2026-10-31): a request that already failed is never a
    // reason to keep spinning. `error` is set from the mutation's own
    // onError, while `isPending` belongs to the observer, which can miss
    // that update (seen in development builds, where React mounts twice):
    // it said "pending" forever, and with `error` set the 10 s fallback
    // above never armed either.
    (!authWaitTimedOut &&
      !error &&
      ((login.isPending && !activeSession) ||
        acceptInvite.isPending ||
        (devBypassLogin.isPending && !activeSession) ||
        (devPersonaLogin.isPending && !activeSession) ||
        (me.isLoading && !!accessToken && !activeSession) ||
        (!activeSession && !!autoLoginData && !error && !login.isError && !devBypassLogin.isError)))
  ) {
    return (
      <div className="flex h-full items-center justify-center text-[var(--c-fg-muted)]">
        <Spinner size={32} />
      </div>
    );
  }

  if (!activeSession) {
    const showBrowserLogin = Boolean(
      loginModes.data?.nonTelegram.available && !hasTelegramInitData,
    );
    const showDevLogin = shouldShowDevPersonas;
    const showSignInButton = !showBrowserLogin && !showDevLogin;
    const canRetryInvite = Boolean(inviteToken && hasTelegramInitData && error);
    return (
      <div className="flex h-full flex-col items-center gap-4 overflow-y-auto px-6 py-8 text-center">
        <h1 className="text-old-display font-semibold">Compass</h1>
        {/* Outside Telegram there is no ID to share (AUTH-8: production
            browsers were asked to send an ID that was not on screen). */}
        {!hasTelegramInitData ? null : (
          <>
            <p className="text-old-body text-[var(--c-fg-muted)]">{i18n.t('auth.shareThisId')}</p>
            {/* 2026-10-21 audit CA-50 / A-14: the line above asks the user to
                send their ID to an admin, but the ID was never on screen. */}
            <TelegramIdChip />
          </>
        )}
        {/* 2026-10-21 audit CA-48 / E-18: the title was hard-coded Chinese
            and the login-mode diagnostic (dev/browser login internals,
            Chinese only) showed in production Telegram after 10 s. The
            diagnostic is now DEV-only; production gets a translated hint. */}
        {authWaitTimedOut ? (
          <Banner tone="warn" title={i18n.t('auth.loginTimeout.title')}>
            {import.meta.env.DEV
              ? loginDiagnosticText(i18n, loginModes.data, loginModes.error?.message)
              : i18n.t('auth.loginTimeout.body')}
          </Banner>
        ) : null}
        {error ? (
          <Banner tone="danger" title={i18n.t('auth.errors.signInFailed')}>
            {/* The generic failure is already the title; don't say it twice. */}
            {authErrorText(i18n, error) === i18n.t('auth.errors.signInFailed')
              ? null
              : authErrorText(i18n, error)}
          </Banner>
        ) : null}
        {showDevLogin ? (
          <DevPersonaPicker
            personas={(devPersonas.data ?? []) as DevPersona[]}
            loading={devPersonas.isLoading}
            error={devPersonas.error ? nonTelegramErrorMessage(i18n, devPersonas.error.message) : null}
            pending={devPersonaLogin.isPending}
            onSelect={(memberId) => {
              setError(null);
              devPersonaLogin.mutate({ memberId });
            }}
            onAutoLogin={() => {
              setError(null);
              loginAttempted.current = true;
              devBypassLogin.mutate();
            }}
          />
        ) : null}
        {canRetryInvite ? (
          <Button
            onClick={() => {
              const initData = getTg()?.initData;
              if (!initData || !inviteToken) return;
              setError(null);
              inviteAttempted.current = false;
              acceptInvite.mutate({ initData, token: inviteToken, locale: i18n.locale });
            }}
          >
            {i18n.t('auth.retryInvite')}
          </Button>
        ) : null}
        {showSignInButton ? (
          <Button
            onClick={() => {
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
            }}
          >
            {i18n.t('auth.signIn')}
          </Button>
        ) : null}
        {showBrowserLogin ? (
          <form
            className="mt-2 flex w-full max-w-sm flex-col gap-3 rounded-[var(--r-card)] bg-[var(--c-surface)] p-4 text-left ring-hairline"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              nonTelegramLogin.mutate({
                tgUserId: browserTgUserId.trim(),
                accessCode: browserAccessCode,
                locale: i18n.locale,
              });
            }}
          >
            <div className="text-center">
              <div className="text-old-h3 font-semibold text-[var(--c-fg)]">
                {i18n.t('dev.browserLogin.title')}
              </div>
              <p className="mt-1 text-old-body-sm text-[var(--c-fg-muted)]">
                {i18n.t('dev.browserLogin.body')}
              </p>
            </div>
            <label className="block">
              <span className="mb-1 block text-old-label font-semibold text-[var(--c-fg-muted)]">
                Telegram ID
              </span>
              <Input
                inputMode="numeric"
                autoComplete="username"
                value={browserTgUserId}
                onChange={(e) => setBrowserTgUserId(e.target.value)}
                autoFocus={!browserTgUserId}
                placeholder={i18n.t('dev.browserLogin.tgIdPlaceholder', { example: '6402913074' })}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-old-label font-semibold text-[var(--c-fg-muted)]">
                {i18n.t('dev.browserLogin.accessCode')}
              </span>
              <Input
                type="password"
                autoComplete="current-password"
                value={browserAccessCode}
                onChange={(e) => setBrowserAccessCode(e.target.value)}
                autoFocus={!!browserTgUserId}
                placeholder={i18n.t('dev.browserLogin.accessCodePlaceholder')}
              />
            </label>
            <Button
              block
              type="submit"
              loading={nonTelegramLogin.isPending}
              disabled={!browserTgUserId.trim() || !browserAccessCode}
            >
              {i18n.t('dev.browserLogin.submit')}
            </Button>
          </form>
        ) : null}
      </div>
    );
  }

  // Onboarding gate: a freshly-signed-up user (or an admin-invited
  // placeholder) confirms their name before seeing the rest of the app.
  // Until they finish, no business pages render — keeps the rule that
  // names appear in approval / audit logs from leaking placeholder
  // strings.
  if (activeSession.needsOnboarding) {
    return <OnboardingScreen />;
  }

  const block = accessBlock(activeSession);
  if (block === 'noStore') return <NoStoreScreen />;
  if (block === 'noAccess') return <NoAccessScreen />;
  return <>{children}</>;
}

/**
 * RE-COPY-9 (2026-10-31): the dev / test sign-in errors are catalog keys
 * now (`auth.errors.*`), so these screens follow the UI language instead of
 * a hard-coded Chinese switch. Anything else is shown as the server sent it.
 */
function nonTelegramErrorMessage(i18n: ReturnType<typeof useI18n>, message: string): string {
  // An unknown message is not a key: format() hands it back unchanged.
  return i18n.t(message as Parameters<typeof i18n.t>[0]);
}

interface LoginModeDiagnostics {
  environment?: {
    nodeEnv: string;
    releaseChannel: string;
    localRequest: boolean;
  };
  devPersona?: {
    available: boolean;
    enabled: boolean;
    reason: string | null;
  };
  nonTelegram?: {
    available: boolean;
    enabled: boolean;
    reason: string | null;
  };
}

function loginDiagnosticText(
  i18n: ReturnType<typeof useI18n>,
  modes: LoginModeDiagnostics | undefined,
  queryError: string | undefined,
): string {
  if (queryError) return i18n.t('dev.diag.queryFailed', { error: queryError });
  if (!modes) return i18n.t('dev.diag.waiting');
  const reason = (r: string | null | undefined) =>
    r ? nonTelegramErrorMessage(i18n, r) : i18n.t('dev.diag.unknownReason');
  const dev = modes.devPersona?.available
    ? i18n.t('dev.diag.devOk')
    : i18n.t('dev.diag.devUnavailable', { reason: reason(modes.devPersona?.reason) });
  const browser = modes.nonTelegram?.available
    ? i18n.t('dev.diag.browserOk')
    : i18n.t('dev.diag.browserUnavailable', { reason: reason(modes.nonTelegram?.reason) });
  return i18n.t('dev.diag.summary', {
    dev,
    browser,
    env: modes.environment?.nodeEnv ?? '?',
    channel: modes.environment?.releaseChannel ?? '?',
    local: i18n.t(modes.environment?.localRequest ? 'dev.diag.yes' : 'dev.diag.no'),
  });
}

function DevPersonaPicker({
  personas,
  loading,
  error,
  pending,
  onSelect,
  onAutoLogin,
}: {
  personas: DevPersona[];
  loading: boolean;
  error: string | null;
  pending: boolean;
  onSelect: (memberId: string) => void;
  onAutoLogin: () => void;
}) {
  const i18n = useI18n();
  const roleText = useRoleLabels();
  return (
    <section className="mt-2 flex w-full max-w-sm flex-col gap-3 rounded-[var(--r-card)] bg-[var(--c-surface)] p-4 text-left ring-hairline">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-old-h3 font-semibold text-[var(--c-fg)]">
            {i18n.t('dev.persona.title')}
          </div>
          <p className="mt-1 text-old-body-sm text-[var(--c-fg-muted)]">
            {i18n.t('dev.persona.body')}
          </p>
          <p className="mt-1 text-old-label text-[var(--c-fg-muted)]">
            {i18n.t('dev.persona.urlHint', { param: '?devAs=…', example: '?devAs=aziz' })}
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0"
          loading={pending}
          onClick={onAutoLogin}
        >
          {i18n.t('dev.persona.auto')}
        </Button>
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-4 text-[var(--c-fg-muted)]">
          <Spinner size={22} />
        </div>
      ) : error ? (
        <Banner tone="danger" title={i18n.t('dev.persona.loadFailed')}>
          {error}
        </Banner>
      ) : personas.length === 0 ? (
        <Banner tone="warn" title={i18n.t('dev.persona.emptyTitle')}>
          {i18n.t('dev.persona.emptyBody')}
        </Banner>
      ) : (
        <div className="grid max-h-[52vh] grid-cols-[minmax(0,1fr)] gap-2 overflow-y-auto pr-1">
          {personas.map((persona) => {
            const stores =
              persona.storeNames.length > 0
                ? persona.storeNames.join(', ')
                : i18n.t('dev.persona.noStores');
            const roles =
              persona.roleSlugs.length > 0
                ? persona.roleSlugs.map((slug) => roleText.name({ slug })).join(', ')
                : i18n.t('dev.persona.noRoles');
            return (
              <button
                key={persona.memberId}
                type="button"
                disabled={pending}
                onClick={() => onSelect(persona.memberId)}
                className="press w-full rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-3 py-2 text-left ring-hairline disabled:opacity-50"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 truncate text-old-body font-semibold text-[var(--c-fg)]">
                    {persona.displayName}
                  </div>
                  <div className="shrink-0 rounded-full bg-[var(--c-surface)] px-2 py-0.5 text-old-label font-semibold text-[var(--c-fg-muted)] ring-hairline">
                    {persona.isAdmin ? roleText.name({ slug: 'admin' }) : `R${persona.maxRank}`}
                  </div>
                </div>
                <div className="mt-1 truncate text-old-body-sm text-[var(--c-fg-muted)]">
                  {persona.orgName} · {roles}
                </div>
                <div className="mt-0.5 truncate text-old-label text-[var(--c-fg-muted)]">
                  {stores} · {i18n.t('people.permissionCount', { n: persona.permissionCount })}
                  {persona.tgUserId ? ` · TG ${persona.tgUserId}` : ''}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * One-shot name-confirmation screen. Pre-fills the user's Telegram name
 * (or admin-set placeholder), lets them change it once, then locks it.
 */
function OnboardingScreen() {
  const session = useAuthStore((s) => s.session);
  const setSession = useAuthStore((s) => s.setSession);
  const accessToken = useAuthStore((s) => s.accessToken);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const i18n = useI18n();
  const initial =
    session?.user.displayName && !session.user.displayName.startsWith('tg:')
      ? session.user.displayName
      : '';
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const translateError = useTranslateError();

  const complete = trpc.auth.completeOnboarding.useMutation({
    onSuccess(updatedSession) {
      haptic('success');
      if (accessToken && refreshToken) {
        setSession({ accessToken, refreshToken, session: updatedSession });
      }
    },
    onError(err) {
      haptic('error');
      // 2026-10-21 audit CA-48: server keys (e.g. auth.errors.nameLocked)
      // were shown raw.
      setError(translateError(err, 'auth.onboarding.failed'));
    },
  });

  // DX-SHL-6 (2026-11-01): a real form, so Enter (the keyboard's "done")
  // submits, and the label is tied to the field (it was read out as the
  // placeholder only).
  const canSubmit = name.trim().length >= 1 && !complete.isPending;
  return (
    <form
      className="flex h-full flex-col px-6 pt-12 pb-8"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) complete.mutate({ displayName: name.trim() });
      }}
    >
      <div className="flex-1 flex flex-col justify-center gap-4">
        <h1 className="text-old-h1 font-semibold leading-tight text-[var(--c-fg)]">
          {i18n.t('auth.onboarding.title')}
        </h1>
        <p className="text-old-body leading-relaxed text-[var(--c-fg-muted)]">
          {i18n.t('auth.onboarding.body')}
        </p>
        <div>
          <label
            htmlFor={nameId}
            className="block text-old-label font-semibold text-[var(--c-fg-muted)]"
          >
            {i18n.t('auth.onboarding.nameLabel')}
          </label>
          <Input
            id={nameId}
            enterKeyHint="done"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            placeholder={i18n.t('auth.onboarding.namePlaceholder')}
            autoFocus
            className="mt-1"
          />
        </div>
        {error ? (
          <Banner tone="danger" title={i18n.t('auth.onboarding.failed')}>
            {error}
          </Banner>
        ) : null}
      </div>
      <Button
        block
        size="lg"
        type="submit"
        loading={complete.isPending}
        disabled={name.trim().length < 1}
      >
        {i18n.t('auth.onboarding.continue')}
      </Button>
    </form>
  );
}

/** Confirmed name but no store assigned yet — wait for admin. */
function NoStoreScreen() {
  const i18n = useI18n();
  return (
    <BlockedScreen title={i18n.t('auth.noStore.title')} body={i18n.t('auth.noStore.body')} />
  );
}

function NoAccessScreen() {
  const i18n = useI18n();
  return (
    <BlockedScreen title={i18n.t('auth.noAccess.title')} body={i18n.t('auth.noAccess.body')} />
  );
}

/**
 * CMP-SHL-1 (2026-10-31): "no role" and "no store" were dead ends — no way
 * to check again once the administrator had acted, no way out, and no sign
 * of who was signed in. Now: who (name, Telegram id to send to the
 * administrator), Retry (re-reads the session; the app opens as soon as
 * access is there) and a way out — inside Telegram that closes the Mini
 * App, since the Telegram account is the identity; in a browser it signs
 * out. Who to ask follows D24: roles, members and stores → administrator.
 */
function BlockedScreen({ title, body }: { title: string; body: string }) {
  const i18n = useI18n();
  const toast = useToast();
  const session = useAuthStore((s) => s.session);
  const clear = useAuthStore((s) => s.clear);
  const refreshSession = useRefreshSession();
  const [checking, setChecking] = useState(false);
  const inTelegram = Boolean(getTg()?.initData);
  const tgUserId =
    session?.user.tgUserId ?? (inTelegram ? String(getTg()?.initDataUnsafe?.user?.id ?? '') : '');
  const name = session?.user.displayName;
  return (
    <div className="flex h-full flex-col px-6 pt-12 pb-8">
      <div className="flex flex-1 flex-col items-center gap-4 text-center">
        <h1 className="text-old-h1 font-semibold">{title}</h1>
        <p className="text-old-body text-[var(--c-fg-muted)]">{body}</p>
        {name && !name.startsWith('tg:') ? (
          <p className="text-old-body-sm text-[var(--c-fg-muted)]">
            {i18n.t('auth.blocked.signedInAs', { name })}
          </p>
        ) : null}
        {tgUserId ? (
          <>
            <p className="text-old-body-sm text-[var(--c-fg-muted)]">{i18n.t('auth.shareThisId')}</p>
            <TelegramIdChip id={tgUserId} />
          </>
        ) : null}
      </div>
      <div className="flex flex-col gap-2">
        <Button
          block
          size="lg"
          loading={checking}
          onClick={() => {
            setChecking(true);
            void refreshSession().then((applied) => {
              setChecking(false);
              // Granted: the gate re-renders into the app on its own.
              const now = useAuthStore.getState().session;
              if (!applied) toast.error(i18n.t('common.networkError'));
              else if (now && accessBlock(now)) toast.info(i18n.t('auth.blocked.stillBlocked'));
            });
          }}
        >
          {i18n.t('common.retry')}
        </Button>
        <Button
          block
          size="lg"
          variant="secondary"
          onClick={() => {
            const tg = inTelegram ? getTg() : null;
            if (tg) {
              tg.close();
              return;
            }
            noteSessionCleared('blocked-sign-out');
            clear();
          }}
        >
          {i18n.t(inTelegram ? 'auth.blocked.close' : 'auth.blocked.signOut')}
        </Button>
      </div>
    </div>
  );
}

/** A Telegram user id (the caller's by default), tap to copy. */
function TelegramIdChip({ id }: { id?: string } = {}) {
  const tgUserId = id ?? getTg()?.initDataUnsafe?.user?.id;
  if (!tgUserId) return null;
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(String(tgUserId)).then(
          () => haptic('success'),
          () => undefined,
        );
      }}
      className="press rounded-full bg-[var(--c-surface-2)] px-4 py-2 font-mono text-old-body ring-hairline"
    >
      {tgUserId}
    </button>
  );
}
