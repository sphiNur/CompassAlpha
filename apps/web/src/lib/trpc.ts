import { createTRPCReact, httpLink, loggerLink } from '@trpc/react-query';
import type { AppRouter } from '@compass/api/src/trpc/router';
import { useAuthStore, type AuthSession } from '../stores/authStore';
import { getLogger, type LogEvent } from '@compass/telemetry';
import { isRefreshRejected } from './networkError';

export const trpc = createTRPCReact<AppRouter>();

// VITE_API_URL is empty in production (api served on the same origin
// behind nginx). `||` (not `??`) so empty-string falls back to ''
// rather than becoming '(empty)/trpc'.
const API_URL = (import.meta.env.VITE_API_URL || '') as string;

/**
 * Ship client log events to `system.log`. Plain fetch on purpose: this
 * must not go through authFetch, whose refresh-and-retry path logs.
 */
export async function sendClientLogs(events: LogEvent[]): Promise<void> {
  const token = useAuthStore.getState().accessToken;
  const res = await fetch(`${API_URL}/trpc/system.log`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ events }),
    keepalive: true,
  });
  // The endpoint is public and treats a stale token as anonymous, so a
  // non-2xx is about the batch or the server; throwing re-queues it.
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
}

async function refreshAccessToken(): Promise<{
  accessToken: string;
  refreshToken: string;
} | null> {
  if (refreshInFlight) return refreshInFlight;
  const refreshToken = useAuthStore.getState().refreshToken;
  if (!refreshToken) return null;
  if (Date.now() - refreshIncompleteAt < REFRESH_COOLDOWN_MS) return null;

  refreshInFlight = (async () => {
    try {
      // guardedFetch: a refresh that hangs would hold every request
      // waiting on it (single-flight); time it out, sooner than a write.
      const res = await guardedFetch(
        `${API_URL}/trpc/auth.refresh`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        },
        REFRESH_TIMEOUT_MS,
      );
      if (!res.ok) {
        // Refresh token itself is bad: clear auth so AuthGate routes the
        // user back through telegramLogin. Anything else (5xx, 429) is
        // the server having a moment; keep the session and let the
        // caller's request fail on its own.
        if (isRefreshRejected(res.status)) {
          noteSessionCleared('refresh-rejected', res.status);
          useAuthStore.getState().clear();
        } else {
          refreshIncompleteAt = Date.now();
          refreshIncompleteStatus = res.status;
          noteRefreshIncomplete(`http ${res.status}`);
        }
        return null;
      }
      const json = (await res.json()) as {
        result?: {
          data?: {
            tokens?: { accessToken: string; refreshToken: string };
            session?: AuthSession;
          };
        };
      };
      const tokens = json.result?.data?.tokens;
      const session = json.result?.data?.session;
      if (!tokens?.accessToken || !tokens?.refreshToken || !session) return null;
      useAuthStore.getState().setSession({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        session,
      });
      return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
    } catch (err) {
      refreshIncompleteAt = Date.now();
      const gateway = /\(gateway (\d{3})\)/.exec(err instanceof Error ? err.message : '');
      refreshIncompleteStatus = gateway ? Number(gateway[1]) : null;
      noteRefreshIncomplete(err instanceof Error ? err.message : 'fetch failed');
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
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
/** Queries may wait this long for an answer, writes a little longer. */
const READ_TIMEOUT_MS = 20_000;
const WRITE_TIMEOUT_MS = 30_000;
/** What a proxy says when the API behind it is restarting or unreachable. */
const GATEWAY_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);

/**
 * One request that cannot hang and does not mistake a proxy's error page
 * for an answer (N3/N5, 2026-10-30):
 *   - no timeout meant a stalled 3G request kept a button spinning and a
 *     write out of the offline queue; it now fails after 20 s (30 s for
 *     a write) as a network failure;
 *   - a 502/503/52x HTML page from nginx or Cloudflare while the API
 *     restarts (every deploy) failed JSON parsing as an ordinary error,
 *     so the write was refused instead of queued; it is a network failure.
 * A caller's own abort (a cancelled query) still surfaces as an abort.
 */
export async function guardedFetch(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs?: number,
): Promise<Response> {
  const isWrite = (init.method ?? 'GET').toUpperCase() !== 'GET';
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    timeoutMs ?? (isWrite ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS),
  );
  const outer = init.signal;
  const forward = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', forward, { once: true });
  }
  try {
    const res = await fetch(input, { ...init, signal: controller.signal });
    if (GATEWAY_STATUSES.has(res.status) && !(res.headers.get('content-type') ?? '').includes('json')) {
      throw new TypeError(`Failed to fetch (gateway ${res.status})`);
    }
    return res;
  } catch (err) {
    if (timedOut) throw new TypeError('Failed to fetch (timed out)');
    throw err;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', forward);
  }
}

export async function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const attach = (token: string | null): RequestInit => ({
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });

  let token = useAuthStore.getState().accessToken;
  let res = await guardedFetch(input, attach(token));
  if (res.status !== 401) return res;

  // 401 → try to refresh, then retry once. We don't refresh on the
  // /auth.refresh route itself (would loop) nor on the /auth.telegramLogin
  // route (anonymous by design).
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('/auth.refresh') || url.includes('/auth.telegramLogin')) {
    return res;
  }
  // refreshAccessToken clears the session itself when the server rejects
  // the refresh token. A refresh that merely failed to complete (offline,
  // api restarting, throttled) says nothing about the session, so it must
  // not reach the caller as UNAUTHORIZED: AuthGate drops the session on
  // an unauthorized `auth.me`, and a mutation would fail outright instead
  // of going to the offline queue. Surface it as the network failure it is.
  const hadRefreshToken = !!useAuthStore.getState().refreshToken;
  const refreshed = await refreshAccessToken();
  if (!refreshed) {
    if (hadRefreshToken && useAuthStore.getState().refreshToken) {
      throw refreshIncompleteError(refreshIncompleteStatus);
    }
    return res;
  }
  token = refreshed.accessToken;
  res = await guardedFetch(input, attach(token));
  return res;
}

/**
 * Use `httpLink` (no batching) instead of `httpBatchLink`.
 *
 * iOS Telegram WebView intermittently rejects tRPC's batched URL pattern
 * (`?batch=1` + array body + `trpc-accept` custom header) with
 * `TypeError: Load failed` — the fetch never even reaches the server.
 * The same iOS WebView happily POSTs to the exact same endpoint when
 * the request is a single, non-batched call (proven via in-app raw
 * fetch diagnostic). Batching is a perf nicety; correctness wins.
 */
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
 */
export const IDEMPOTENT_MUTATIONS = new Set<string>([
  'run.create',
  'run.purchaseItem',
  'run.revisePurchase',
  'run.finish',
  'sales.record',
  'settlement.save',
  'order.submit',
  // 2026-07-26: all three are already declared `idempotentMutation`
  // server-side, but the middleware short-circuits on "no key = no
  // dedupe" — with the client never sending the header, the cache was
  // dead code for them.
  //
  // Membership here alone only buys the authFetch 401-refresh retry
  // (that path re-issues the SAME init, so the key survives). Surviving
  // a LOST RESPONSE additionally needs a stable key threaded through
  // op.context, which addPurchaserItem / addExpense now do (RunPage's
  // addItemIdemCtx / addExpenseIdemCtx + the outbox replay). Without
  // that, `genKey()` below mints a fresh key per attempt and the replay
  // never matches.
  //
  // attachSessions has no offline-replay path, so the 401 retry is the
  // whole of its benefit — which is still worth having, since a double
  // attach would pull other stores' orders into a run twice.
  'run.addPurchaserItem',
  // 2026-10-21 audit CA-54: declared idempotentMutation server-side;
  // StoreInventoryTab threads a stable key per wastage entry.
  'inventory.recordWastage',
  // DX-INV-2 (2026-11-01): stocktake too; one stable key per count.
  'inventory.stocktake',
  'run.addExpense',
  'run.attachSessions',
  // BUY-9 (2026-10-30): declared idempotentMutation and given a stable
  // key by RunPage since #91, but never listed here, so the header was
  // never sent and a replay after a lost response raised a false
  // "please review" warning.
  'run.markUnavailable',
  'run.deliverToStore',
]);

function genKey(): string {
  // Lightweight ULID-like: 26 chars, lex-sortable. crypto.randomUUID
  // is fine too but the dash format is uglier in logs.
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
