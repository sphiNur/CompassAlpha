/**
 * Realtime subscription. Opens a WebSocket to /ws?token=<accessToken>
 * once the user has a session, and invalidates the relevant TanStack
 * Query keys whenever the server fans out an event.
 *
 * Strategy: server tells us "something changed in this org" with a
 * coarse `order.changed` / `run.changed` message. Rather than diff in
 * the client, we just invalidate queries — TanStack Query then refetches
 * as needed. Cheap and correct.
 *
 * Reconnect: exponential backoff up to 30 s. Closes cleanly on signOut.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useAuthStore } from '../stores/authStore';
import { trpc } from '../lib/trpc';
import { useRefreshSession } from '../lib/refreshSession';
import { ORDER_CHANGED_KEYS, RUN_CHANGED_KEYS } from './realtimeKeys';
import { hasLocalWrites } from '../lib/localWrites';

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
// Coalesce bursts of WebSocket `order.changed` / `run.changed` into one
// invalidate per quiet window. Without this, hammering the +/- button
// fans out one ws message per tap → one invalidate per tap → one
// refetch per tap → the qty visually flickers between optimistic and
// server values mid-stream.
const INVALIDATE_DEBOUNCE_MS = 400;
const MUTATION_QUIET_RETRY_MS = 250;
const MUTATION_QUIET_MAX_WAIT_MS = 2_500;
// DX-ORD-1: taps still in a screen's debounce or in flight hold the
// refetch longer — a refetch landing among them undoes a tap on screen.
// Bounded so a stuck write can't freeze the page's data for good.
const LOCAL_WRITES_MAX_WAIT_MS = 10_000;

/**
 * Should a due invalidate wait? While mutations run (any screen) for up to
 * MUTATION_QUIET_MAX_WAIT_MS, and while a screen holds unsent local writes
 * (DX-ORD-1) for up to LOCAL_WRITES_MAX_WAIT_MS. Exported for tests.
 */
export function shouldDeferInvalidate(
  mutating: boolean,
  localWrites: boolean,
  waitedMs: number,
): boolean {
  if (localWrites && waitedMs < LOCAL_WRITES_MAX_WAIT_MS) return true;
  return mutating && waitedMs < MUTATION_QUIET_MAX_WAIT_MS;
}
// 2026-10-21 audit CA-35: close codes the API's WS layer uses.
const WS_CLOSE_EVICTED = 4000;
const WS_CLOSE_TOKEN_EXPIRED = 4001;
/** Query-key roots refreshed when the socket re-opens (CA-35). */
const REOPEN_INVALIDATE_KEYS = ['order', 'run', 'catalog', 'admin', 'notifications', 'nav'] as const;

// The server pings every socket every 25 s (apps/api/src/main.ts). An
// open socket that has heard nothing for longer than this is treated as
// dead (a phone that changed networks can keep a half-open TCP socket for
// minutes without a close event), so pages fall back to polling.
export const REALTIME_STALE_MS = 60_000;
const STALE_CHECK_MS = 10_000;

/** Is the socket delivering pushes? Open and heard from recently. */
export function isRealtimeLive(open: boolean, lastMessageAt: number, now: number): boolean {
  return open && now - lastMessageAt <= REALTIME_STALE_MS;
}

// P-4 (2026-10-31): one module-level flag so pages poll only while
// realtime is down, instead of on top of a healthy socket. It changes only
// on transitions, so subscribers do not re-render on every ping.
let realtimeLive = false;
const liveListeners = new Set<() => void>();

export function setRealtimeLive(live: boolean): void {
  if (realtimeLive === live) return;
  realtimeLive = live;
  liveListeners.forEach((l) => l());
}

export function getRealtimeLive(): boolean {
  return realtimeLive;
}

function subscribeRealtimeLive(listener: () => void): () => void {
  liveListeners.add(listener);
  return () => {
    liveListeners.delete(listener);
  };
}

/** True while the WebSocket is delivering pushes. */
export function useRealtimeLive(): boolean {
  return useSyncExternalStore(subscribeRealtimeLive, getRealtimeLive, () => false);
}

/** A query's refetchInterval: poll only while realtime pushes are not arriving. */
export function pollWhenOffline(intervalMs: number, live: boolean): number | false {
  return live ? false : intervalMs;
}

interface RealtimeMessage {
  type:
    | 'order.changed'
    | 'run.changed'
    // catalog.changed / people.changed added 2026-05-03 so admin pages
    // (stores, skus, suppliers, categories, members, role bindings)
    // auto-refresh when another admin in the org commits a change.
    | 'catalog.changed'
    | 'people.changed'
    | 'notification'
    // 2026-10-21 audit CA-35 / E-06: the hub drops its OLDEST socket at the
    // connection cap and sends this, but used to leave it open — a zombie
    // that never received another event.
    | 'evicted'
    | 'ping';
  orgId?: string;
  sessionId?: string;
  runId?: string;
  entity?: 'store' | 'sku' | 'supplier' | 'category';
  title?: string;
  body?: string;
}

function wsUrl(token: string): string {
  const fromEnv = import.meta.env.VITE_WS_URL as string | undefined;
  if (fromEnv) {
    const sep = fromEnv.includes('?') ? '&' : '?';
    return `${fromEnv}${sep}token=${encodeURIComponent(token)}`;
  }
  // Default: same-origin /ws over wss (or ws if loaded over http).
  if (typeof location === 'undefined') return '';
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`;
}

export function useRealtime(): void {
  const accessToken = useAuthStore((s) => s.accessToken);
  const orgId = useAuthStore((s) => s.session?.member.orgId ?? null);
  const queryClient = useQueryClient();
  // Ref, not a dep: the utils object's identity isn't guaranteed stable
  // and a new one must not tear down a healthy socket.
  const utils = trpc.useUtils();
  const utilsRef = useRef(utils);
  utilsRef.current = utils;
  const refreshSession = useRefreshSession();
  const refreshSessionRef = useRef(refreshSession);
  refreshSessionRef.current = refreshSession;
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const stoppedRef = useRef(false);

  useEffect(() => {
    if (!accessToken || !orgId) return;
    stoppedRef.current = false;
    // Per-effect flag: stoppedRef is shared with the NEXT effect run (a new
    // token re-runs this effect), so async work started here checks this.
    let disposed = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    // Debounced invalidate so a burst of N ws events for the same query
    // key collapses into ONE refetch after the burst settles.
    const pendingInvalidates = new Map<string, ReturnType<typeof setTimeout>>();
    const debouncedInvalidate = (queryKey: QueryKey, startedAt = Date.now()) => {
      const id = JSON.stringify(queryKey);
      const existing = pendingInvalidates.get(id);
      if (existing) clearTimeout(existing);
      const t = setTimeout(() => {
        const waitForLocalWrites = shouldDeferInvalidate(
          queryClient.isMutating() > 0,
          hasLocalWrites(),
          Date.now() - startedAt,
        );
        if (waitForLocalWrites) {
          const retry = setTimeout(() => {
            pendingInvalidates.delete(id);
            debouncedInvalidate(queryKey, startedAt);
          }, MUTATION_QUIET_RETRY_MS);
          pendingInvalidates.set(id, retry);
          return;
        }
        pendingInvalidates.delete(id);
        void queryClient.invalidateQueries({ queryKey });
      }, INVALIDATE_DEBOUNCE_MS);
      pendingInvalidates.set(id, t);
    };

    // 2026-10-21 audit CA-35 / E-05: events broadcast while the socket was
    // down (Telegram backgrounded, network blip) are lost, so every
    // re-open after the first one invalidates what they would have.
    let hasOpened = false;
    // After an eviction, keep the backoff growing instead of resetting it
    // on the next open, so repeated evictions can't spin at 1 s.
    let reopenAfterEviction = false;
    // Liveness for pollers (P-4): open + heard from within REALTIME_STALE_MS.
    let socketOpen = false;
    let lastMessageAt = 0;
    const updateLive = () => setRealtimeLive(isRealtimeLive(socketOpen, lastMessageAt, Date.now()));
    const staleTimer = setInterval(updateLive, STALE_CHECK_MS);

    const connect = () => {
      if (stoppedRef.current) return;
      const url = wsUrl(accessToken);
      if (!url) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;

      ws.addEventListener('open', () => {
        if (!reopenAfterEviction) reconnectAttemptsRef.current = 0;
        reopenAfterEviction = false;
        if (wsRef.current === ws) {
          socketOpen = true;
          lastMessageAt = Date.now();
          updateLive();
        }
        if (hasOpened) {
          for (const key of REOPEN_INVALIDATE_KEYS) debouncedInvalidate([[key]]);
        }
        hasOpened = true;
      });

      ws.addEventListener('message', (e) => {
        if (wsRef.current === ws) {
          lastMessageAt = Date.now();
          updateLive();
        }
        let msg: RealtimeMessage;
        try {
          msg = JSON.parse(e.data) as RealtimeMessage;
        } catch {
          return;
        }
        switch (msg.type) {
          // HIS-6 / DX-CAT-1: see realtimeKeys.ts for what each makes stale.
          case 'order.changed':
            for (const key of ORDER_CHANGED_KEYS) debouncedInvalidate([key]);
            break;
          case 'run.changed':
            for (const key of RUN_CHANGED_KEYS) debouncedInvalidate([key]);
            break;
          case 'catalog.changed':
            // Catalog changes ripple into many admin queries AND into
            // the public-ish catalog queries used by OrderPage etc.
            // Hit both: any tRPC procedure starting with `admin.` AND
            // the `catalog.*` ones used by the order screen.
            debouncedInvalidate([['admin']]);
            debouncedInvalidate([['catalog']]);
            // CAT-12 (2026-10-30): the purchaser's expense templates.
            debouncedInvalidate([['run', 'expenseTemplates']]);
            break;
          case 'people.changed':
            // Member / role binding / store assignment changes.
            // The admin people page reads multiple list queries; one
            // coarse `[admin]` invalidation covers them all.
            debouncedInvalidate([['admin']]);
            // ADM-24 (2026-10-30): the change may be to this person's own
            // roles; re-read the session so tabs and pages follow it
            // instead of failing on the next request.
            void refreshSessionRef.current();
            break;
          case 'notification':
            debouncedInvalidate([['notifications']]);
            break;
          case 'evicted':
            // Close; the close handler reconnects with backoff.
            reopenAfterEviction = true;
            try {
              ws.close(WS_CLOSE_EVICTED, 'evicted');
            } catch {
              /* already closing */
            }
            break;
          case 'ping':
          default:
            break;
        }
      });

      ws.addEventListener('close', (ev) => {
        if (wsRef.current === ws) {
          wsRef.current = null;
          socketOpen = false;
          updateLive();
        }
        if (disposed) return;
        if (ev.code === WS_CLOSE_EVICTED) reopenAfterEviction = true;
        if (ev.code === WS_CLOSE_TOKEN_EXPIRED) {
          // Reconnecting with the same token would just be refused again.
          // Any authed tRPC call goes through the client's single-flight
          // refresh on 401; a rotated token re-runs this effect, which
          // opens a fresh socket. Only if the token did NOT change (refresh
          // failed or not needed) fall back to the backoff reconnect.
          void utilsRef.current.client.auth.me
            .query()
            .catch(() => undefined)
            .finally(() => {
              if (disposed) return;
              if (useAuthStore.getState().accessToken !== accessToken) return;
              scheduleReconnect();
            });
          return;
        }
        scheduleReconnect();
      });
      ws.addEventListener('error', () => {
        // Browsers fire close after error; rely on close handler.
      });
    };

    const scheduleReconnect = () => {
      if (disposed || stoppedRef.current) return;
      const attempt = ++reconnectAttemptsRef.current;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
      timeoutHandle = setTimeout(connect, delay);
    };

    connect();

    return () => {
      disposed = true;
      stoppedRef.current = true;
      clearInterval(staleTimer);
      setRealtimeLive(false);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      pendingInvalidates.forEach((t) => clearTimeout(t));
      pendingInvalidates.clear();
      const ws = wsRef.current;
      if (ws && ws.readyState <= 1) ws.close(1000, 'unmount');
      wsRef.current = null;
    };
  }, [accessToken, orgId, queryClient]);
}
