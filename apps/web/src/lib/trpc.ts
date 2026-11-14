import { createTRPCReact, httpLink, loggerLink } from '@trpc/react-query';
import type { AppRouter } from '@compass/api/src/trpc/router';
import { IDEMPOTENT_ROUTES } from '@compass/contracts/idempotency';
import { useAuthStore, type AuthSession } from '../stores/authStore';
import { BatchRefused, getLogger, type LogEvent, type TransportOptions } from '@compass/telemetry';
import { isRefreshRejected } from './networkError';
import { getTg } from './telegram';

export const trpc = createTRPCReact<AppRouter>();

/**
 * What each procedure returns, as a page receives it (JSON, so a date is a
 * string). A page names an output by its procedure, e.g.
 * `RouterOutputs['attendance']['sheet']`, instead of importing the API's
 * own types: this file is where the web reaches into the API. Review
 * ATT-12 (2026-11-12): two attendance pages imported theirs from the
 * router's file.
 */
export type { RouterOutputs } from '@compass/api/src/trpc/outputs';

// VITE_API_URL is empty in production: the api serves the web app
// itself, so both are on one origin. `||` (not `??`) so empty-string
// falls back to '' rather than becoming '(empty)/trpc'.
export const API_URL = (import.meta.env.VITE_API_URL || '') as string;

/**
 * Ship client log events to `system.log`. Plain fetch on purpose: this
 * must not go through authFetch, whose refresh-and-retry path logs.
 */
export async function sendClientLogs(
  events: LogEvent[],
  options: TransportOptions = {},
): Promise<void> {
  const token = useAuthStore.getState().accessToken;
  const res = await fetch(`${API_URL}/trpc/system.log`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ events }),
    // Review MWD-01 (modern-web-guidance: batch-analytics-events): keepalive
    // only for the send on hide, so the 5 s flush does not use the quota.
    keepalive: options.keepalive === true,
    // Review MWD-03 (modern-web-guidance: deprioritize-background-fetches):
    // telemetry must not compete with the page's own requests.
    priority: 'low',
  });
  // The endpoint is public and treats a stale token as anonymous, so a
  // non-2xx is about the batch or the server. COREAPI-04: a batch the
  // server refused is dropped (sending it again gets the same answer);
  // anything else, a 429 included, is queued again.
  if (res.status >= 400 && res.status < 500 && res.status !== 429) {
    throw new BatchRefused(res.status);
  }
  if (!res.ok) throw new Error(`system.log answered ${res.status}`);
}

/** Losing the session unmounts the whole app, which looks like a reload
 *  from the outside. Record why it happened. */
export function noteSessionCleared(reason: string, status?: number): void {
  try {
    getLogger().log('warn', 'auth.cleared', { action: reason, data: { status } });
  } catch {
    /* logger not booted */
  }
}

function noteRefreshIncomplete(why: string): void {
  try {
    getLogger().log('warn', 'auth.refresh', { action: 'incomplete', errorMsg: why });
  } catch {
    /* logger not booted */
  }
}

/**
 * Single-flight refresh: while a refresh is in-flight, every other 401
 * waits on the same promise instead of triggering parallel refreshes.
 * Without this, when the access token expires every concurrent request
 * (e.g. the 4 queries OrderPage fires on mount) would each independently
 * try to refresh — racy and wasteful.
 */
let refreshInFlight: Promise<{ accessToken: string; refreshToken: string } | null> | null = null;

/**
 * RE-AUTH-5 (2026-10-30): a refresh that hung kept the order page on a
 * spinner for ~95 s. The refresh is a POST, so it waited the 30 s write
 * timeout, and each of react-query's two retries waited for a fresh
 * refresh again. A refresh is small and every request on screen is
 * queued behind it: give up after 10 s, and for a few seconds after one
 * did not complete fail the follow-up 401s at once instead of starting
 * another — the retries land inside that window, so the page shows its
 * network error after ~10 s, and a Retry tapped later tries afresh.
 */
const REFRESH_TIMEOUT_MS = 10_000;
const REFRESH_COOLDOWN_MS = 5_000;
let refreshIncompleteAt = Number.NEGATIVE_INFINITY;
/**
 * R2-AUTH-3 (2026-10-31): why the last refresh did not complete — the
 * server's own status when it answered with an error, null when no answer
 * came. A 500 was reported as "check your connection".
 */
let refreshIncompleteStatus: number | null = null;

/** The error a request fails with when its session refresh did not complete. */
export function refreshIncompleteError(serverStatus: number | null): TypeError {
  return new TypeError(
    serverStatus === null
      ? 'Failed to fetch (session refresh did not complete)'
      : `Failed to fetch (session refresh did not complete: server ${serverStatus})`,
  );
}

/** Tests only: forget the last incomplete refresh. */
export function resetRefreshCooldownForTests(): void {
  refreshIncompleteAt = Number.NEGATIVE_INFINITY;
  refreshIncompleteStatus = null;
  bootRefreshStarted = false;
}

/**
 * Review MWD-14 (modern-web-guidance: privacy): asks auth.refresh to read
 * the HttpOnly refresh cookie when the body carries no token (the server
 * reads the cookie only with it; apps/api/src/http/refreshCookie.ts).
 */
const REFRESH_COOKIE_HEADERS = {
  'content-type': 'application/json',
  'x-compass-refresh': 'cookie',
} as const;

type Tokens = { accessToken: string; refreshToken: string };
type SignInAnswer =
  | { kind: 'ok'; tokens: Tokens; session: AuthSession }
  | { kind: 'rejected'; status: number }
  | { kind: 'incomplete'; status: number | null; why: string };

/**
 * One call that answers with tokens and a session (auth.refresh, or
 * auth.telegramLogin as the fallback). `credentials: 'include'` so the
 * refresh cookie is sent, and the one in the answer kept, when the api is
 * on another origin (development); in production both are one origin.
 */
async function signInCall(path: string, body: unknown): Promise<SignInAnswer> {
  try {
    // guardedFetch: a refresh that hangs would hold every request
    // waiting on it (single-flight); time it out, sooner than a write.
    const res = await guardedFetch(
      `${API_URL}/trpc/${path}`,
      {
        method: 'POST',
        headers: REFRESH_COOKIE_HEADERS,
        credentials: 'include',
        body: JSON.stringify(body),
      },
      REFRESH_TIMEOUT_MS,
    );
    if (!res.ok) {
      // Refused (4xx other than 408/429): this credential is no good.
      // Anything else (5xx, 429) is the server having a moment.
      if (isRefreshRejected(res.status)) return { kind: 'rejected', status: res.status };
      return { kind: 'incomplete', status: res.status, why: `http ${res.status}` };
    }
    const json = (await res.json()) as {
      result?: { data?: { tokens?: Partial<Tokens>; session?: AuthSession } };
    };
    const tokens = json.result?.data?.tokens;
    const session = json.result?.data?.session;
    if (!tokens?.accessToken || !tokens.refreshToken || !session) {
      return { kind: 'incomplete', status: res.status, why: 'answer without tokens' };
    }
    return {
      kind: 'ok',
      tokens: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
      session,
    };
  } catch (err) {
    const gateway = /\(gateway (\d{3})\)/.exec(err instanceof Error ? err.message : '');
    return {
      kind: 'incomplete',
      status: gateway ? Number(gateway[1]) : null,
      why: err instanceof Error ? err.message : 'fetch failed',
    };
  }
}

/** Is there a session a refresh could renew (the cookie, or a token held here)? */
function canRefresh(): boolean {
  const s = useAuthStore.getState();
  return !!s.session || !!s.refreshToken || !!s.legacyRefreshToken;
}

/**
 * Get a fresh access token. Review MWD-14 (modern-web-guidance: privacy):
 * the refresh token is no longer in localStorage, so this tries, in order,
 * stopping at the first that works:
 *   1. a refresh token an older build saved (moved to the cookie by this
 *      first refresh; the server sets the cookie on every answer);
 *   2. the HttpOnly cookie (no token in the body);
 *   3. the refresh token the server last returned to this page, held in
 *      memory, for a browser that did not keep the cookie;
 *   4. inside Telegram, a silent sign-in from initData, the same one the
 *      app makes at start. The saved session stays, so the screen, the tab
 *      and the offline copy of the data are kept; another person's
 *      answer replaces them as a sign-out would.
 * A step that gets no answer (offline, 5xx, 429) stops the chain and
 * leaves the session alone, as before: it says nothing about the session.
 * Only when every step is refused is the session cleared, which sends
 * AuthGate back to the sign-in screen.
 *
 * `boot`: the refresh the app starts with (startSessionRefresh). When it
 * is refused everywhere but an older build's access token is still held,
 * the session is kept until that token runs out (its first 401 then
 * takes this path again, without `boot`).
 */
async function refreshAccessToken(options: { boot?: boolean } = {}): Promise<Tokens | null> {
  if (refreshInFlight) return refreshInFlight;
  if (!canRefresh()) return null;
  if (Date.now() - refreshIncompleteAt < REFRESH_COOLDOWN_MS) return null;

  refreshInFlight = (async () => {
    const epoch = useAuthStore.getState().epoch;
    const priorUserId = useAuthStore.getState().session?.user.id ?? null;
    /** Keep a sign-in or sign-out made while this was in flight. */
    const superseded = () => useAuthStore.getState().epoch !== epoch;
    const incomplete = (answer: { status: number | null; why: string }) => {
      refreshIncompleteAt = Date.now();
      refreshIncompleteStatus = answer.status;
      noteRefreshIncomplete(answer.why);
      return null;
    };
    const accept = (answer: { tokens: Tokens; session: AuthSession }, how: string) => {
      if (superseded()) {
        const now = useAuthStore.getState();
        return now.accessToken && now.refreshToken
          ? { accessToken: now.accessToken, refreshToken: now.refreshToken }
          : null;
      }
      // Someone else's session (the fallback sign-in): drop this one's
      // tab and offline copy first, as a sign-out does.
      if (priorUserId && answer.session.user.id !== priorUserId) {
        noteSessionCleared('refresh-other-user');
        useAuthStore.getState().clear();
      }
      useAuthStore.getState().setSession({ ...answer.tokens, session: answer.session });
      if (how !== 'cookie') noteRefreshVia(how);
      return answer.tokens;
    };
    try {
      const state = useAuthStore.getState();
      const attempts: Array<{ how: string; body: { refreshToken?: string } }> = [];
      if (state.legacyRefreshToken) {
        attempts.push({ how: 'saved', body: { refreshToken: state.legacyRefreshToken } });
      }
      attempts.push({ how: 'cookie', body: {} });
      if (state.refreshToken && state.refreshToken !== state.legacyRefreshToken) {
        attempts.push({ how: 'memory', body: { refreshToken: state.refreshToken } });
      }
      for (const attempt of attempts) {
        const answer = await signInCall('auth.refresh', attempt.body);
        if (answer.kind === 'ok') return accept(answer, attempt.how);
        if (answer.kind === 'incomplete') return incomplete(answer);
        // Refused: an older build's token is not tried again.
        if (attempt.how === 'saved' && !superseded()) {
          useAuthStore.setState({ legacyRefreshToken: null });
        }
      }
      if (superseded()) return null;

      // Every refresh was refused. Inside Telegram, sign in again from
      // initData (the safety net for a cookie the browser did not keep).
      const initData = getTg()?.initData;
      if (initData) {
        const answer = await signInCall('auth.telegramLogin', { initData });
        if (answer.kind === 'ok') return accept(answer, 'telegram');
        if (answer.kind === 'incomplete') return incomplete(answer);
      }
      if (superseded()) return null;
      if (options.boot && useAuthStore.getState().accessToken) return null;
      // Refresh token itself is bad: clear auth so AuthGate routes the
      // user back through telegramLogin.
      noteSessionCleared('refresh-rejected');
      useAuthStore.getState().clear();
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

let bootRefreshStarted = false;

/**
 * Review MWD-14 (modern-web-guidance: privacy): the access token is not
 * saved, so a start with a saved session gets one here, once, before the
 * pages ask (they would also get one on their first call, through
 * authFetch). A session saved by an older build is moved to the cookie
 * here too. Offline, this fails as a network failure: the app opens on the
 * saved session and the offline copy, and the next call online tries again.
 * Not while an invite is being accepted: that sign-in may switch the
 * workspace, and this refresh would race it.
 */
export async function startSessionRefresh(): Promise<void> {
  if (bootRefreshStarted) return;
  const s = useAuthStore.getState();
  if (!s.session) return;
  if (s.accessToken && !s.legacyRefreshToken) return;
  bootRefreshStarted = true;
  await refreshAccessToken({ boot: true });
}

function noteRefreshVia(how: string): void {
  try {
    getLogger().log('info', 'auth.refresh', { action: how });
  } catch {
    /* logger not booted */
  }
}

/**
 * Calls that sign in or are open to anyone: they never wait for a refresh
 * first (one of them is the refresh itself).
 */
const SIGN_IN_PATHS = new Set([
  'auth.refresh',
  'auth.telegramLogin',
  'auth.acceptInvite',
  'auth.nonTelegramLogin',
  'auth.devBypassLogin',
  'auth.devPersonaLogin',
  'auth.devPersonas',
  'auth.loginModes',
]);

function trpcPath(url: string): string {
  const path = url.split('?')[0] ?? url;
  const i = path.indexOf('/trpc/');
  return i < 0 ? '' : path.slice(i + '/trpc/'.length);
}

/** Queries may wait this long for an answer, writes a little longer. */
const READ_TIMEOUT_MS = 20_000;
const WRITE_TIMEOUT_MS = 30_000;
/**
 * Writes that upload photos and wait for the server's face checks
 * (2026-11-07): an enrollment is up to ten photos (~2 MB) checked one by
 * one, over a slow cross-border link it took longer than 30 s, and the
 * phone gave up while the server was still working.
 */
const PHOTO_WRITE_TIMEOUT_MS = 120_000;
const PHOTO_WRITES = ['/attendance.faceEnroll', '/attendance.punch'];

/** How long a request may take: reads 20 s, writes 30 s, photo uploads 120 s. */
export function requestTimeoutMs(url: string, method: string): number {
  if (method.toUpperCase() === 'GET') return READ_TIMEOUT_MS;
  const path = url.split('?')[0] ?? url;
  return PHOTO_WRITES.some((p) => path.endsWith(p)) ? PHOTO_WRITE_TIMEOUT_MS : WRITE_TIMEOUT_MS;
}
/** What a proxy says when the API behind it is restarting or unreachable. */
const GATEWAY_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);
/** Statuses a Response may not carry a body with. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * One request that cannot hang and does not mistake a proxy's error page
 * for an answer (N3/N5, 2026-10-30):
 *   - no timeout meant a stalled 3G request kept a button spinning and a
 *     write out of the offline queue; it now fails after 20 s (30 s for
 *     a write) as a network failure;
 *   - a 502/503/52x HTML page from nginx or Cloudflare while the API
 *     restarts (every deploy) failed JSON parsing as an ordinary error,
 *     so the write was refused instead of queued; it is a network failure.
 *   - COREWEB2-05: the timeout used to end when the headers arrived, so
 *     an answer whose body stalled after them hung the caller again. The
 *     body is now read inside the same timeout and abort.
 * A caller's own abort (a cancelled query) still surfaces as an abort.
 */
export async function guardedFetch(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs?: number,
): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    timeoutMs ?? requestTimeoutMs(url, init.method ?? 'GET'),
  );
  const outer = init.signal;
  const forward = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', forward, { once: true });
  }
  try {
    const res = await fetch(input, { ...init, signal: controller.signal });
    if (
      GATEWAY_STATUSES.has(res.status) &&
      !(res.headers.get('content-type') ?? '').includes('json')
    ) {
      throw new TypeError(`Failed to fetch (gateway ${res.status})`);
    }
    const body = NULL_BODY_STATUSES.has(res.status) ? null : await res.arrayBuffer();
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  } catch (err) {
    if (timedOut) throw new TypeError('Failed to fetch (timed out)');
    throw err;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', forward);
  }
}

/**
 * Custom fetch that:
 *   1. Attaches the current access token as Bearer.
 *   2. On a 401 response (UNAUTHORIZED → access token expired),
 *      transparently calls auth.refresh and retries the request once
 *      with the new token.
 *   3. A refresh token the server rejects = clear auth and let AuthGate
 *      re-login via Telegram initData. A refresh that could not reach
 *      the server leaves the session alone.
 *
 * This is THE missing piece that was causing every mutation to fail
 * with `auth.errors.required` after the 15-minute access-token TTL.
 */
export async function authFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const attach = (token: string | null): RequestInit => ({
    ...init,
    // Review MWD-14: the auth calls set or clear the refresh cookie; send
    // and keep it when the api is on another origin (development), as
    // signInCall does. Same origin in production, where this changes
    // nothing.
    ...(isAuthCall ? { credentials: 'include' as const } : {}),
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });

  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const path = trpcPath(url);
  const isSignIn = path.split(',').some((p) => SIGN_IN_PATHS.has(p));
  const isAuthCall = path.split(',').some((p) => p.startsWith('auth.'));

  let token = useAuthStore.getState().accessToken;
  // Review MWD-14 (modern-web-guidance: privacy): the access token lives
  // in memory, so after a reload there is none until the first refresh.
  // Wait for it (single-flight) instead of sending the call to be refused.
  // The outbox replays through here too, so a queued write is sent with a
  // fresh token, or stays queued while none can be had.
  if (!token && !isSignIn && canRefresh()) {
    const refreshed = await refreshAccessToken();
    token = refreshed?.accessToken ?? useAuthStore.getState().accessToken;
    if (!token && canRefresh()) throw refreshIncompleteError(refreshIncompleteStatus);
  }
  let res = await guardedFetch(input, attach(token));
  if (res.status !== 401) return res;

  // 401 → try to refresh, then retry once. We don't refresh on the
  // /auth.refresh route itself (would loop) nor on the sign-in routes
  // (anonymous by design).
  if (isSignIn) return res;
  // refreshAccessToken clears the session itself when every way to renew
  // it is refused. A refresh that merely failed to complete (offline, api
  // restarting, throttled) says nothing about the session, so it must
  // not reach the caller as UNAUTHORIZED: AuthGate drops the session on
  // an unauthorized `auth.me`, and a mutation would fail outright instead
  // of going to the offline queue. Surface it as the network failure it is.
  const hadSession = canRefresh();
  const refreshed = await refreshAccessToken();
  if (!refreshed) {
    if (hadSession && canRefresh()) {
      throw refreshIncompleteError(refreshIncompleteStatus);
    }
    return res;
  }
  token = refreshed.accessToken;
  res = await guardedFetch(input, attach(token));
  return res;
}

/**
 * M1.20 (2026-05-08): mutations that the server marks idempotent
 * (run.create, run.purchaseItem, sales.record, order.submit, etc.)
 * accept an `X-Idempotency-Key` header. The server caches the
 * response for 24h keyed on (key, route, userId).
 *
 * H2 (2026-07-03): a caller can supply a STABLE key via the per-op
 * `context.idempotencyKey`. run.purchaseItem uses this so the first
 * attempt and its offline-queue replay send the SAME key — a request
 * the server already committed but whose response was lost (the iOS
 * "Load failed" case) then dedupes on replay instead of double-charging.
 * Mutations without a context key fall back to a fresh per-request key.
 *
 * Review TEST3-06 (2026-11-10): the routes are listed once, in
 * @compass/contracts/idempotency, which the API checks its routers
 * against; a web test used to read the API's router files as text.
 */
export const IDEMPOTENT_MUTATIONS: ReadonlySet<string> = new Set<string>(IDEMPOTENT_ROUTES);

function genKey(): string {
  // Lightweight ULID-like: the time in base 36 (8 chars), then 26 random
  // ones from crypto.randomUUID (about 20 from the Math.random fallback),
  // lex-sortable by time. A plain UUID would do, but the dashes are
  // uglier in logs.
  const rand = (
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '')
      : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  ).slice(0, 26);
  return `${Date.now().toString(36)}${rand}`.slice(0, 64);
}

/**
 * Mint a stable idempotency key for one logical action. Pass it to the
 * first attempt via the mutation's `trpc.context.idempotencyKey` AND store
 * it on the offline-outbox entry, so a replay reuses the SAME key and the
 * server dedupes a lost-response retry (H2).
 */
export function newIdempotencyKey(): string {
  return genKey();
}

/**
 * The app's tRPC client. It uses `httpLink` (no batching) instead of
 * `httpBatchLink`.
 *
 * iOS Telegram WebView intermittently rejects tRPC's batched URL pattern
 * (`?batch=1` + array body + `trpc-accept` custom header) with
 * `TypeError: Load failed` — the fetch never even reaches the server.
 * The same iOS WebView happily POSTs to the exact same endpoint when
 * the request is a single, non-batched call (proven via in-app raw
 * fetch diagnostic). Batching is a perf nicety; correctness wins.
 */
export function buildTrpcClient() {
  return trpc.createClient({
    links: [
      loggerLink({ enabled: () => import.meta.env.DEV }),
      httpLink({
        url: `${API_URL}/trpc`,
        // Custom fetch: handles Bearer auth + transparent refresh on 401.
        fetch: authFetch,
        // M1.20: attach X-Idempotency-Key to opted-in mutations.
        // Queries get no header (idempotent already); non-listed
        // mutations also get none (compatible with older server).
        headers: ({ op }) => {
          if (op.type === 'mutation' && IDEMPOTENT_MUTATIONS.has(op.path)) {
            // Prefer a caller-supplied stable key (first attempt + offline
            // replay share one via op.context) so a lost-response retry
            // dedupes; otherwise a fresh per-request key for one-shots.
            const ctxKey = (op.context as { idempotencyKey?: unknown } | undefined)?.idempotencyKey;
            return {
              'x-idempotency-key':
                typeof ctxKey === 'string' && ctxKey.length > 0 ? ctxKey : genKey(),
            };
          }
          return {};
        },
      }),
    ],
  });
}
