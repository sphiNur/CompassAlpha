/**
 * Review MWD-14 (modern-web-guidance: privacy): the tokens are no longer
 * saved. The access token is in memory, the refresh token in an HttpOnly
 * cookie; authFetch renews the session through the chain in
 * refreshAccessToken (lib/trpc.ts): an older build's saved token, the
 * cookie, the token held in memory, then Telegram's initData.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { testSession } from '../../__tests__/fixtures/session';
import { REFRESH_TOKEN_PLACEHOLDER, savedAuth, useAuthStore } from '../../stores/authStore';
import { isLikelyNetworkError } from '../networkError';
import { authFetch, resetRefreshCooldownForTests, startSessionRefresh } from '../trpc';

interface Call {
  path: string;
  body: unknown;
  credentials: RequestCredentials | undefined;
  headers: Record<string, string>;
}

const realFetch = globalThis.fetch;
const g = globalThis as { window?: unknown };
const realWindow = g.window;
const initialAuth = useAuthStore.getState();
let calls: Call[] = [];
/** What each procedure answers: a status, or a thrown network failure. */
let answers: Record<string, Array<number | 'offline'>> = {};
const session = testSession();

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let issued = 0;
const signedIn = (userId = 'u1') => {
  issued += 1;
  return {
    result: {
      data: {
        tokens: { accessToken: `access-${issued}`, refreshToken: `refresh-${issued}` },
        session: testSession({ user: { ...session.user, id: userId } }),
      },
    },
  };
};

function inTelegram(initData: string | null) {
  g.window = initData === null ? undefined : { Telegram: { WebApp: { initData } } };
}

beforeEach(() => {
  calls = [];
  answers = {};
  issued = 0;
  resetRefreshCooldownForTests();
  inTelegram(null);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.split('/trpc/')[1]?.split('?')[0] ?? url;
    const headers = { ...((init?.headers as Record<string, string> | undefined) ?? {}) };
    calls.push({
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      credentials: init?.credentials,
      headers,
    });
    const next = answers[path]?.shift() ?? 200;
    if (next === 'offline') throw new TypeError('Failed to fetch');
    if (path === 'auth.refresh' || path === 'auth.telegramLogin') {
      return next === 200 ? json(200, signedIn()) : json(next, { error: {} });
    }
    // Any other call: 401 without a token, 200 with one.
    if (!headers.authorization) return json(401, { error: {} });
    return json(next, { result: { data: 'ok' } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  g.window = realWindow;
  useAuthStore.setState(initialAuth, true);
  resetRefreshCooldownForTests();
});

const paths = () => calls.map((c) => c.path);
const refreshBodies = () => calls.filter((c) => c.path === 'auth.refresh').map((c) => c.body);

describe('a start with a saved session and no access token (MWD-14)', () => {
  it('renews from the cookie before the first call, then sends it with the new token', async () => {
    useAuthStore.setState({ session, accessToken: null, refreshToken: null });
    const res = await authFetch('/trpc/order.todaySession');
    expect(res.status).toBe(200);
    expect(paths()).toEqual(['auth.refresh', 'order.todaySession']);
    const refresh = calls[0]!;
    expect(refresh.body).toEqual({});
    expect(refresh.credentials).toBe('include');
    expect(refresh.headers['x-compass-refresh']).toBe('cookie');
    expect(calls[1]!.headers.authorization).toBe('Bearer access-1');
    expect(useAuthStore.getState().accessToken).toBe('access-1');
    // Held in memory, as the fallback for a cookie the browser drops.
    expect(useAuthStore.getState().refreshToken).toBe('refresh-1');
  });

  it('calls made together wait for one refresh', async () => {
    useAuthStore.setState({ session, accessToken: null, refreshToken: null });
    await Promise.all([
      authFetch('/trpc/order.todaySession'),
      authFetch('/trpc/nav.counts'),
      authFetch('/trpc/catalog.skus'),
    ]);
    expect(paths().filter((p) => p === 'auth.refresh')).toHaveLength(1);
  });

  it('offline: a network failure, the session and the outbox owner kept', async () => {
    useAuthStore.setState({ session, accessToken: null, refreshToken: null });
    answers['auth.refresh'] = ['offline'];
    const err = await authFetch('/trpc/order.todaySession').catch((e) => e);
    expect(isLikelyNetworkError(err)).toBe(true);
    expect(useAuthStore.getState().session?.user.id).toBe('u1');
    expect(paths()).toEqual(['auth.refresh']);
  });

  it('sign-in calls do not wait for a refresh', async () => {
    useAuthStore.setState({ session, accessToken: null, refreshToken: null });
    await authFetch('/trpc/auth.telegramLogin', { method: 'POST' });
    await authFetch('/trpc/auth.loginModes');
    expect(paths()).toEqual(['auth.telegramLogin', 'auth.loginModes']);
  });
});

describe('moving an older build’s saved refresh token to the cookie (MWD-14)', () => {
  it('sends it once in the body, then no longer saves it', async () => {
    useAuthStore.setState({
      session,
      accessToken: 'old-access',
      refreshToken: null,
      legacyRefreshToken: 'legacy-refresh-token-xxxxxxxx',
    });
    const boot = startSessionRefresh();
    // A call made meanwhile goes out with the old token, which still works.
    await authFetch('/trpc/order.todaySession');
    await boot;
    expect(refreshBodies()[0]).toEqual({ refreshToken: 'legacy-refresh-token-xxxxxxxx' });
    expect(refreshBodies()).toHaveLength(1);
    const state = useAuthStore.getState();
    expect(state.legacyRefreshToken).toBeNull();
    expect(state.accessToken).toBe('access-1');
    const saved = savedAuth(state) as unknown as Record<string, unknown>;
    expect(saved.refreshToken).toBe(REFRESH_TOKEN_PLACEHOLDER);
    expect(saved).not.toHaveProperty('accessToken');
    expect(JSON.stringify(saved)).not.toContain('refresh-1');
    expect(JSON.stringify(saved)).not.toContain('access-1');
  });

  it('offline at that start: the saved token stays saved for the next try', async () => {
    useAuthStore.setState({
      session,
      accessToken: null,
      legacyRefreshToken: 'legacy-refresh-token-xxxxxxxx',
    });
    answers['auth.refresh'] = ['offline'];
    await authFetch('/trpc/order.todaySession').catch(() => {});
    const state = useAuthStore.getState();
    expect(state.legacyRefreshToken).toBe('legacy-refresh-token-xxxxxxxx');
    const saved = savedAuth(state) as unknown as Record<string, unknown>;
    expect(saved.refreshToken).toBe('legacy-refresh-token-xxxxxxxx');
  });

  it('refused: the cookie is tried next', async () => {
    useAuthStore.setState({
      session,
      accessToken: null,
      legacyRefreshToken: 'bad-legacy-token-xxxxxxxx',
    });
    answers['auth.refresh'] = [401, 200];
    await authFetch('/trpc/order.todaySession');
    expect(refreshBodies()).toEqual([{ refreshToken: 'bad-legacy-token-xxxxxxxx' }, {}]);
    expect(useAuthStore.getState().accessToken).toBe('access-1');
  });

  it('refused everywhere at start, outside Telegram: the old access token is used until it runs out', async () => {
    useAuthStore.setState({
      session,
      accessToken: 'old-access',
      legacyRefreshToken: 'bad-legacy-token-xxxxxxxx',
    });
    answers['auth.refresh'] = [401, 401];
    await startSessionRefresh();
    // The old token still answers.
    const res = await authFetch('/trpc/order.todaySession');
    expect(res.status).toBe(200);
    const state = useAuthStore.getState();
    expect(state.session?.user.id).toBe('u1');
    expect(state.accessToken).toBe('old-access');
    expect(state.legacyRefreshToken).toBeNull();
  });
});

describe('when the cookie does not work (MWD-14 fallbacks)', () => {
  it('the refresh token held in memory is sent in the body', async () => {
    useAuthStore.setState({
      session,
      accessToken: 'expired',
      refreshToken: 'memory-token-xxxxxxxxxxxx',
    });
    answers['order.todaySession'] = [401];
    answers['auth.refresh'] = [401, 200];
    const res = await authFetch('/trpc/order.todaySession');
    expect(res.status).toBe(200);
    expect(refreshBodies()).toEqual([{}, { refreshToken: 'memory-token-xxxxxxxxxxxx' }]);
  });

  it('inside Telegram, a silent sign-in from initData keeps the session', async () => {
    inTelegram('user=%7B%7D&hash=x');
    useAuthStore.setState({ session, accessToken: null, refreshToken: null, currentStoreId: 's1' });
    answers['auth.refresh'] = [401];
    const res = await authFetch('/trpc/order.todaySession');
    expect(res.status).toBe(200);
    expect(paths()).toEqual(['auth.refresh', 'auth.telegramLogin', 'order.todaySession']);
    expect(calls[1]!.body).toEqual({ initData: 'user=%7B%7D&hash=x' });
    expect(calls[1]!.credentials).toBe('include');
    expect(useAuthStore.getState().session?.user.id).toBe('u1');
    expect(useAuthStore.getState().currentStoreId).toBe('s1');
  });

  it('everything refused outside Telegram: signed out, the call answers 401', async () => {
    useAuthStore.setState({ session, accessToken: null, refreshToken: null });
    answers['auth.refresh'] = [401];
    const res = await authFetch('/trpc/order.todaySession');
    expect(res.status).toBe(401);
    expect(useAuthStore.getState().session).toBeNull();
  });

  it('a server error on the way stops the chain and keeps the session', async () => {
    inTelegram('user=%7B%7D&hash=x');
    useAuthStore.setState({ session, accessToken: null, refreshToken: null });
    answers['auth.refresh'] = [503];
    const err = await authFetch('/trpc/order.todaySession').catch((e) => e);
    expect(isLikelyNetworkError(err)).toBe(true);
    expect(paths()).toEqual(['auth.refresh']);
    expect(useAuthStore.getState().session?.user.id).toBe('u1');
  });
});

describe('a sign-in while a refresh is in flight', () => {
  it('keeps the sign-in; the refresh does not overwrite it', async () => {
    useAuthStore.setState({ session, accessToken: null, refreshToken: null });
    const pending = authFetch('/trpc/order.todaySession');
    useAuthStore.getState().setSession({
      accessToken: 'invite-access',
      refreshToken: 'invite-refresh',
      session: testSession({ member: { ...session.member, orgId: 'o2' } }),
    });
    await pending;
    expect(useAuthStore.getState().accessToken).toBe('invite-access');
    expect(useAuthStore.getState().session?.member.orgId).toBe('o2');
  });
});
