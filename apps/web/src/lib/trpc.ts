import { createTRPCReact, httpLink, loggerLink } from '@trpc/react-query';
import type { AppRouter } from '@compass/api/src/trpc/router';
import { useAuthStore, type AuthSession } from '../stores/authStore';

export const trpc = createTRPCReact<AppRouter>();

// VITE_API_URL is empty in production (api served on the same origin
// behind nginx). `||` (not `??`) so empty-string falls back to ''
// rather than becoming '(empty)/trpc'.
const API_URL = (import.meta.env.VITE_API_URL || '') as string;

/**
 * Single-flight refresh: while a refresh is in-flight, every other 401
 * waits on the same promise instead of triggering parallel refreshes.
 * Without this, when the access token expires every concurrent request
 * (e.g. the 4 queries OrderPage fires on mount) would each independently
 * try to refresh — racy and wasteful.
 */
let refreshInFlight: Promise<{ accessToken: string; refreshToken: string } | null> | null = null;

async function refreshAccessToken(): Promise<{
  accessToken: string;
  refreshToken: string;
} | null> {
  if (refreshInFlight) return refreshInFlight;
  const refreshToken = useAuthStore.getState().refreshToken;
  if (!refreshToken) return null;

  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${API_URL}/trpc/auth.refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        // 401 / 410 / etc. — refresh token itself is bad. Clear auth so
        // AuthGate routes the user back through telegramLogin.
        useAuthStore.getState().clear();
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
    } catch {
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
 *   3. Failure of refresh = clear auth and let AuthGate re-login via
 *      Telegram initData.
 *
 * This is THE missing piece that was causing every mutation to fail
 * with `auth.errors.required` after the 15-minute access-token TTL.
 */
async function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const attach = (token: string | null): RequestInit => ({
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });

  let token = useAuthStore.getState().accessToken;
  let res = await fetch(input, attach(token));
  if (res.status !== 401) return res;

  // 401 → try to refresh, then retry once. We don't refresh on the
  // /auth.refresh route itself (would loop) nor on the /auth.telegramLogin
  // route (anonymous by design).
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('/auth.refresh') || url.includes('/auth.telegramLogin')) {
    return res;
  }
  const refreshed = await refreshAccessToken();
  if (!refreshed) {
    useAuthStore.getState().clear();
    return res;
  }
  token = refreshed.accessToken;
  res = await fetch(input, attach(token));
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
 * Today's FE generates a fresh ULID per mutation attempt — this
 * doesn't dedupe double-taps (each tap = new key) since react-query
 * mutations don't auto-retry by default. The value is defense-in-
 * depth: if a future config change enables retries, OR an external
 * integration replays a mutation with the same key, dedupe kicks in.
 *
 * For offline-queue replays (useOfflineQueue), the entry's clientSeq
 * could be used as a stable key — that's the high-value follow-up
 * once we have a reproducer for ghost double-charges.
 */
const IDEMPOTENT_MUTATIONS = new Set<string>([
  'run.create',
  'run.purchaseItem',
  'run.revisePurchase',
  'run.finish',
  'sales.record',
  'order.submit',
]);

function genKey(): string {
  // Lightweight ULID-like: 26 chars, lex-sortable. crypto.randomUUID
  // is fine too but the dash format is uglier in logs.
  const rand =
    (typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '')
      : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
    ).slice(0, 26);
  return `${Date.now().toString(36)}${rand}`.slice(0, 64);
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
            return { 'x-idempotency-key': genKey() };
          }
          return {};
        },
      }),
    ],
  });
}
