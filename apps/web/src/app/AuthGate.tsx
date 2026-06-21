import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Banner, EmptyState, Input, Spinner } from '@compass/ui';
import { useAuthStore } from '../stores/authStore';
import { trpc } from '../lib/trpc';
import { getTg, haptic } from '../hooks/useTelegram';
import { useI18n } from '../hooks/useI18n';

interface AuthGateProps {
  children: ReactNode;
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
  const setSession = useAuthStore((s) => s.setSession);
  const clear = useAuthStore((s) => s.clear);
  const i18n = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [browserTgUserId, setBrowserTgUserId] = useState('');
  const [browserAccessCode, setBrowserAccessCode] = useState('');
  /** True once we've issued a telegramLogin call this mount cycle. */
  const loginAttempted = useRef(false);
  /** True once `auth.me` failed with UNAUTHORIZED — don't auto-login again. */
  const meUnauthorized = useRef(false);

  const me = trpc.auth.me.useQuery(undefined, {
    enabled: !!accessToken,
    retry: false,
  });
  const nonTelegramStatus = trpc.auth.nonTelegramStatus.useQuery(undefined, {
    enabled: !session,
    retry: false,
    staleTime: 60_000,
  });

  // If an existing token is bad, drop it. In Telegram Mini App we can
  // immediately re-login from initData; outside Telegram, keep the
  // manual sign-in fallback.
  useEffect(() => {
    if (!me.isError) return;
    const code = (me.error as { data?: { code?: string } } | undefined)?.data?.code;
    if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') {
      const hasTelegramInitData = Boolean(getTg()?.initData);
      meUnauthorized.current = !hasTelegramInitData;
      if (hasTelegramInitData) loginAttempted.current = false;
      clear();
    }
  }, [me.isError, me.error, clear]);

  // Refresh session in store when auth.me succeeds.
  useEffect(() => {
    if (!me.data) return;
    const at = useAuthStore.getState().accessToken;
    const rt = useAuthStore.getState().refreshToken;
    if (!at || !rt) return;
    setSession({ accessToken: at, refreshToken: rt, session: me.data });
  }, [me.data, setSession]);

  const login = trpc.auth.telegramLogin.useMutation({
    onSuccess(data) {
      setSession({
        accessToken: data.tokens.accessToken,
        refreshToken: data.tokens.refreshToken,
        session: data.session,
      });
      meUnauthorized.current = false;
      setError(null);
    },
    onError(err) {
      setError(err.message);
    },
  });
  const nonTelegramLogin = trpc.auth.nonTelegramLogin.useMutation({
    onSuccess(data) {
      setSession({
        accessToken: data.tokens.accessToken,
        refreshToken: data.tokens.refreshToken,
        session: data.session,
      });
      meUnauthorized.current = false;
      setError(null);
    },
    onError(err) {
      setError(nonTelegramErrorMessage(err.message));
    },
  });

  // Auto-login exactly once per mount, gated by ref so UNAUTHORIZED on me
  // can't restart the cycle.
  useEffect(() => {
    if (session) return;
    if (loginAttempted.current) return;
    if (meUnauthorized.current && !getTg()?.initData) return;
    if (accessToken) return; // there's a token, let auth.me decide its fate first
    const tg = getTg();
    const initData = tg?.initData;
    // M3.18 (launch hardening): only honor the dev-mock initData in
    // a dev build. `import.meta.env.DEV` is statically replaced by
    // `false` in production, so Rollup tree-shakes the entire mock
    // branch out — the production bundle does not contain the env
    // var name. See vite.config.ts for the build-time hard guard.
    const mock = import.meta.env.DEV ? import.meta.env.VITE_DEV_MOCK_INIT_DATA : null;
    const data = initData || mock;
    if (!data) return;
    loginAttempted.current = true;
    login.mutate({ initData: data });
  }, [session, accessToken, login]);

  const autoLoginData = getTg()?.initData ?? (import.meta.env.DEV ? import.meta.env.VITE_DEV_MOCK_INIT_DATA : null);

  if (
    login.isPending ||
    (me.isLoading && !!accessToken) ||
    (!session && !!autoLoginData && !error && !login.isError)
  ) {
    return (
      <div className="flex h-full items-center justify-center text-[var(--c-fg-muted)]">
        <Spinner size={32} />
      </div>
    );
  }

  if (!session) {
    const hasTelegramInitData = Boolean(getTg()?.initData);
    const showBrowserLogin = Boolean(nonTelegramStatus.data?.enabled && !hasTelegramInitData);
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-display font-semibold">Compass</h1>
        <p className="text-body text-[var(--c-fg-muted)]">{i18n.t('auth.shareThisId')}</p>
        {error ? (
          <Banner tone="danger" title={i18n.t('auth.errors.signInFailed')}>
            {error}
          </Banner>
        ) : null}
        <Button
          onClick={() => {
            loginAttempted.current = true;
            meUnauthorized.current = false;
            // M3.18: same DEV-only guard as the auto-login path above.
            // Production builds never read VITE_DEV_MOCK_INIT_DATA.
            const mock = import.meta.env.DEV ? import.meta.env.VITE_DEV_MOCK_INIT_DATA : null;
            const data = getTg()?.initData ?? mock ?? '';
            if (!data) {
              setError(i18n.t('auth.errors.noInitData'));
              return;
            }
            login.mutate({ initData: data });
          }}
        >
          {i18n.t('auth.signIn')}
        </Button>
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
  if (session.needsOnboarding) {
    return <OnboardingScreen />;
  }

  // After name onboarding, regular staff need at least one store
  // assigned. Admins (users.manage) bypass — they always see all stores.
  const isAdmin = session.permissions.includes('users.manage');
  if (!isAdmin && session.stores.length === 0) {
    return <NoStoreScreen />;
  }

  if (session.permissions.length === 0) {
    return <NoAccessScreen />;
  }
  return <>{children}</>;
}

function nonTelegramErrorMessage(message: string): string {
  switch (message) {
    case 'auth.errors.nonTelegramLoginDisabled':
      return '非 Telegram 测试登录未开启。';
    case 'auth.errors.invalidNonTelegramLogin':
      return 'Telegram ID 或访问码无效，或该用户不在允许名单中。';
    case 'auth.errors.noMembership':
      return '该用户没有可用的组织成员身份。';
    default:
      return message;
  }
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
