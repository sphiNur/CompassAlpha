import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Banner, EmptyState, Input, Spinner } from '@compass/ui';
import { useAuthStore, type AuthSession } from '../stores/authStore';
import { trpc } from '../lib/trpc';
import { getTg, haptic } from '../hooks/useTelegram';
import { useI18n } from '../hooks/useI18n';

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
  const [error, setError] = useState<string | null>(null);
  const [browserTgUserId, setBrowserTgUserId] = useState(initialDevBrowserTgUserId);
  const [browserAccessCode, setBrowserAccessCode] = useState('');
  const [loginSession, setLoginSession] = useState<AuthSession | null>(null);
  const [authWaitTimedOut, setAuthWaitTimedOut] = useState(false);
  const activeSession = session ?? loginSession;
  const hasTelegramInitData = Boolean(getTg()?.initData);
  const forceDevPersonaPicker = wantsDevPersonaPicker();
  /** True once we've issued a telegramLogin call this mount cycle. */
  const loginAttempted = useRef(false);
  /** True once `auth.me` failed with UNAUTHORIZED — don't auto-login again. */
  const meUnauthorized = useRef(false);

  const me = trpc.auth.me.useQuery(undefined, {
    enabled: authHydrated && !!accessToken,
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
      (forceDevPersonaPicker || authWaitTimedOut || error),
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
      setError(err.message);
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
      setError(nonTelegramErrorMessage(err.message));
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
      setError(nonTelegramErrorMessage(err.message));
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
      setError(nonTelegramErrorMessage(err.message));
    },
  });

  const autoLoginData =
    getTg()?.initData ??
    (shouldUseDevBypassLogin() ? 'dev-bypass' : null);

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
    if (activeSession) return;
    if (loginAttempted.current) return;
    if (meUnauthorized.current && !getTg()?.initData) return;
    if (accessToken) return; // there's a token, let auth.me decide its fate first
    const tg = getTg();
    const initData = tg?.initData;
    if (shouldUseDevBypassLogin()) {
      loginAttempted.current = true;
      devBypassLogin.mutate();
      return;
    }
    if (!initData) return;
    loginAttempted.current = true;
    login.mutate({ initData });
  }, [authHydrated, activeSession, accessToken, login, devBypassLogin]);

  if (
    !authHydrated ||
    !authWaitTimedOut &&
    ((login.isPending && !activeSession) ||
    (devBypassLogin.isPending && !activeSession) ||
    (devPersonaLogin.isPending && !activeSession) ||
    (me.isLoading && !!accessToken && !activeSession) ||
    (!activeSession && !!autoLoginData && !error && !login.isError && !devBypassLogin.isError))
  ) {
    return (
      <div className="flex h-full items-center justify-center text-[var(--c-fg-muted)]">
        <Spinner size={32} />
      </div>
    );
  }

  if (!activeSession) {
    const showBrowserLogin = Boolean(loginModes.data?.nonTelegram.available && !hasTelegramInitData);
    const showDevLogin = shouldShowDevPersonas;
    const showSignInButton = !showBrowserLogin && !showDevLogin;
    return (
      <div className="flex h-full flex-col items-center gap-4 overflow-y-auto px-6 py-8 text-center">
        <h1 className="text-display font-semibold">Compass</h1>
        <p className="text-body text-[var(--c-fg-muted)]">{i18n.t('auth.shareThisId')}</p>
        {authWaitTimedOut ? (
          <Banner tone="warn" title="登录等待时间过长">
            {loginDiagnosticText(loginModes.data, loginModes.error?.message)}
          </Banner>
        ) : null}
        {error ? (
          <Banner tone="danger" title={i18n.t('auth.errors.signInFailed')}>
            {error}
          </Banner>
        ) : null}
        {showDevLogin ? (
          <DevPersonaPicker
            personas={(devPersonas.data ?? []) as DevPersona[]}
            loading={devPersonas.isLoading}
            error={devPersonas.error ? nonTelegramErrorMessage(devPersonas.error.message) : null}
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
        {showSignInButton ? (
          <Button
            onClick={() => {
              loginAttempted.current = true;
              meUnauthorized.current = false;
              if (shouldUseDevBypassLogin()) {
                devBypassLogin.mutate();
                return;
              }
              const data = getTg()?.initData ?? '';
              if (!data) {
                setError(i18n.t('auth.errors.noInitData'));
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
              <div className="text-h3 font-semibold text-[var(--c-fg)]">
                开发/测试浏览器登录
              </div>
              <p className="mt-1 text-body-sm text-[var(--c-fg-muted)]">
                仅限服务端白名单人员，正式发布环境不可用。
              </p>
            </div>
            <label className="block">
              <span className="mb-1 block text-label font-semibold text-[var(--c-fg-muted)]">
                Telegram ID
              </span>
              <Input
                inputMode="numeric"
                autoComplete="username"
                value={browserTgUserId}
                onChange={(e) => setBrowserTgUserId(e.target.value)}
                autoFocus={!browserTgUserId}
                placeholder="例如 6402913074"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-label font-semibold text-[var(--c-fg-muted)]">
                访问码
              </span>
              <Input
                type="password"
                autoComplete="current-password"
                value={browserAccessCode}
                onChange={(e) => setBrowserAccessCode(e.target.value)}
                autoFocus={!!browserTgUserId}
                placeholder="由管理员提供"
              />
            </label>
            <Button
              block
              type="submit"
              loading={nonTelegramLogin.isPending}
              disabled={!browserTgUserId.trim() || !browserAccessCode}
            >
              进入测试环境
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

  // After name onboarding, regular staff need at least one store
  // assigned. Admins (users.manage) bypass — they always see all stores.
  const isAdmin = activeSession.permissions.includes('users.manage');
  if (!isAdmin && activeSession.stores.length === 0) {
    return <NoStoreScreen />;
  }

  if (activeSession.permissions.length === 0) {
    return <NoAccessScreen />;
  }
  return <>{children}</>;
}

function nonTelegramErrorMessage(message: string): string {
  switch (message) {
    case 'auth.errors.nonTelegramLoginDisabled':
      return '非 Telegram 测试登录未开启。';
    case 'auth.errors.nonTelegramProductionDisabled':
      return '正式环境不允许非 Telegram 测试登录。';
    case 'auth.errors.nonTelegramAllowlistEmpty':
      return '非 Telegram 测试登录白名单为空。';
    case 'auth.errors.invalidNonTelegramLogin':
      return 'Telegram ID 或访问码无效，或该用户不在允许名单中。';
    case 'auth.errors.noMembership':
      return '该用户没有可用的组织成员身份。';
    case 'auth.errors.devBypassDisabled':
      return '本地开发自动登录未开启，或当前不是 development 环境。';
    case 'auth.errors.devLocalhostOnly':
      return '开发登录只允许从 localhost 或 127.0.0.1 访问。';
    case 'auth.errors.devDatabaseUnavailable':
      return '本地开发数据库不可用。请启动本地 PostgreSQL，或确认 DATABASE_URL 指向可用的本地副本。';
    case 'auth.errors.devBypassNoMember':
      return '本地数据库里没有可用于自动登录的 active 成员。';
    case 'auth.errors.devPersonaMissing':
      return '选择的开发测试身份不存在或已停用。';
    default:
      return message;
  }
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
  modes: LoginModeDiagnostics | undefined,
  queryError: string | undefined,
): string {
  if (queryError) return `无法读取登录模式：${queryError}`;
  if (!modes) return '正在等待 API 返回登录模式。';
  const dev = modes.devPersona?.available
    ? '开发登录可用'
    : `开发登录不可用：${nonTelegramErrorMessage(modes.devPersona?.reason ?? '未知原因')}`;
  const browser = modes.nonTelegram?.available
    ? '浏览器访问码登录可用'
    : `浏览器访问码登录不可用：${nonTelegramErrorMessage(modes.nonTelegram?.reason ?? '未知原因')}`;
  return `${dev}；${browser}；环境 ${modes.environment?.nodeEnv ?? '?'} / ${modes.environment?.releaseChannel ?? '?'}，本地请求 ${modes.environment?.localRequest ? '是' : '否'}。`;
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
  return (
    <section className="mt-2 flex w-full max-w-sm flex-col gap-3 rounded-[var(--r-card)] bg-[var(--c-surface)] p-4 text-left ring-hairline">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-h3 font-semibold text-[var(--c-fg)]">开发测试身份登录</div>
          <p className="mt-1 text-body-sm text-[var(--c-fg-muted)]">
            只在本地 development 环境显示，用真实成员权限进入前端。
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          loading={pending}
          onClick={onAutoLogin}
        >
          自动
        </Button>
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-4 text-[var(--c-fg-muted)]">
          <Spinner size={22} />
        </div>
      ) : error ? (
        <Banner tone="danger" title="无法读取开发身份">
          {error}
        </Banner>
      ) : personas.length === 0 ? (
        <Banner tone="warn" title="没有可用身份">
          本地数据库里没有 active 成员。请先迁移并初始化本地数据库。
        </Banner>
      ) : (
        <div className="grid max-h-[52vh] gap-2 overflow-y-auto pr-1">
          {personas.map((persona) => {
            const stores =
              persona.storeNames.length > 0 ? persona.storeNames.join(', ') : '未分配店铺';
            const roles =
              persona.roleSlugs.length > 0 ? persona.roleSlugs.join(', ') : '无角色';
            return (
              <button
                key={persona.memberId}
                type="button"
                disabled={pending}
                onClick={() => onSelect(persona.memberId)}
                className="press w-full rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-3 py-2 text-left ring-hairline disabled:opacity-50"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 truncate text-body font-semibold text-[var(--c-fg)]">
                    {persona.displayName}
                  </div>
                  <div className="shrink-0 rounded-full bg-[var(--c-surface)] px-2 py-0.5 text-label font-semibold text-[var(--c-fg-muted)] ring-hairline">
                    {persona.isAdmin ? 'Admin' : `R${persona.maxRank}`}
                  </div>
                </div>
                <div className="mt-1 truncate text-body-sm text-[var(--c-fg-muted)]">
                  {persona.orgName} · {roles}
                </div>
                <div className="mt-0.5 truncate text-label text-[var(--c-fg-muted)]">
                  {stores} · {persona.permissionCount} permissions
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

  const complete = trpc.auth.completeOnboarding.useMutation({
    onSuccess(updatedSession) {
      haptic('success');
      if (accessToken && refreshToken) {
        setSession({ accessToken, refreshToken, session: updatedSession });
      }
    },
    onError(err) {
      haptic('error');
      setError(err.message);
    },
  });

  return (
    <div className="flex h-full flex-col px-6 pt-12 pb-8">
      <div className="flex-1 flex flex-col justify-center gap-4">
        <h1 className="text-h1 font-semibold leading-tight text-[var(--c-fg)]">
          {i18n.t('auth.onboarding.title')}
        </h1>
        <p className="text-body leading-relaxed text-[var(--c-fg-muted)]">
          {i18n.t('auth.onboarding.body')}
        </p>
        <div>
          <label className="block text-label font-semibold text-[var(--c-fg-muted)]">
            {i18n.t('auth.onboarding.nameLabel')}
          </label>
          <Input
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
        loading={complete.isPending}
        disabled={name.trim().length < 1}
        onClick={() => complete.mutate({ displayName: name.trim() })}
      >
        {i18n.t('auth.onboarding.continue')}
      </Button>
    </div>
  );
}

/** Confirmed name but no store assigned yet — wait for admin. */
function NoStoreScreen() {
  const i18n = useI18n();
  return (
    <div className="flex h-full items-center justify-center px-6">
      <EmptyState
        title={i18n.t('auth.noStore.title')}
        description={i18n.t('auth.noStore.body')}
      />
    </div>
  );
}

function NoAccessScreen() {
  const i18n = useI18n();
  const tg = getTg();
  const tgUserId = tg?.initDataUnsafe?.user?.id;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-h1 font-semibold">{i18n.t('auth.noAccess.title')}</h1>
      <p className="text-body text-[var(--c-fg-muted)]">{i18n.t('auth.noAccess.body')}</p>
      <p className="text-body-sm text-[var(--c-fg-muted)]">{i18n.t('auth.shareThisId')}</p>
      {tgUserId ? (
        <button
          type="button"
          onClick={() => navigator.clipboard?.writeText(String(tgUserId))}
          className="press rounded-full bg-[var(--c-surface-2)] px-4 py-2 font-mono text-body ring-hairline"
        >
          {tgUserId}
        </button>
      ) : null}
    </div>
  );
}
