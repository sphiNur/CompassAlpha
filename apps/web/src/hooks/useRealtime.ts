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
 * A socket that has gone quiet (no ping for REALTIME_STALE_MS) is dropped
 * and opened again, and every re-open refreshes what pushes would have.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import {
  WS_CLOSE_EVICTED,
  WS_CLOSE_MEMBERSHIP_ENDED,
  WS_CLOSE_TOKEN_EXPIRED,
  type EvictionNotice,
  type RealtimeMessage,
} from '@compass/contracts/schemas/realtime';
import { useAuthStore } from '../stores/authStore';
import { trpc } from '../lib/trpc';
import { useRefreshSession } from '../lib/refreshSession';
import { PUSH_KEYS, REOPEN_KEYS } from './realtimeKeys';
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
/**
 * What to do once the socket has closed with `code` (review COREWEB2-24).
 * Exported for tests.
 *   - `refreshToken`: the token expired; a refreshed one opens a socket.
 *   - `readSession`: the member was suspended or removed. The upgrade
 *     refuses them, and reconnecting every 30 s went on for good; the
 *     session is read again instead, and AuthGate shows what follows.
 *   - `reconnect`: anything else, with backoff.
 */
export function afterClose(code: number): 'refreshToken' | 'readSession' | 'reconnect' {
  if (code === WS_CLOSE_TOKEN_EXPIRED) return 'refreshToken';
  if (code === WS_CLOSE_MEMBERSHIP_ENDED) return 'readSession';
  return 'reconnect';
}

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

/**
 * COREWEB2-07: should a socket be given up on? One that has heard nothing
 * (or, still connecting, got no answer) for REALTIME_STALE_MS. Only two
 * pollers stood in for a quiet socket, so most pages stopped updating
 * until the half-open connection finally closed, minutes later.
 */
export function isRealtimeStale(lastHeardAt: number, now: number): boolean {
  return now - lastHeardAt > REALTIME_STALE_MS;
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

/**
 * What the socket hears: the hub's pushes, and the notice sent to the
 * oldest socket at the connection cap (2026-10-21 audit CA-35 / E-06: it
 * used to be left open, a zombie that never heard another event).
 */
type Incoming = RealtimeMessage | EvictionNotice;

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
  // 2026-10-21 audit CA-35 / E-05: events broadcast while the socket was
  // down (Telegram backgrounded, network blip) are lost, so every
  // re-open after the first one refreshes what they would have.
  // COREWEB2-08: kept across effect runs. A rotated token re-runs the
  // effect after the server closed the old socket (4001), and that
  // re-open used to count as a first one: no refresh for the gap, about
  // every 15 minutes.
  const openedForRef = useRef<string | null>(null);

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

    const openScope = `${useAuthStore.getState().session?.user.id ?? ''}:${orgId}`;
    // After an eviction, keep the backoff growing instead of resetting it
    // on the next open, so repeated evictions can't spin at 1 s.
    let reopenAfterEviction = false;
    // Liveness for pollers (P-4): open + heard from within REALTIME_STALE_MS.
    let socketOpen = false;
    // Last message, or when the current attempt to connect started.
    let lastMessageAt = 0;
    const updateLive = () => setRealtimeLive(isRealtimeLive(socketOpen, lastMessageAt, Date.now()));

    // COREWEB2-07: give up on a quiet socket and open a new one. Its close
    // event can take minutes on a half-open connection, so it is detached
    // first: the close handler only reconnects for the current socket.
    const dropIfStale = (reconnect: () => void) => {
      const ws = wsRef.current;
      if (!ws || !isRealtimeStale(lastMessageAt, Date.now())) return;
      wsRef.current = null;
      socketOpen = false;
      updateLive();
      try {
        ws.close(1000, 'stale');
      } catch {
        /* already closing */
      }
      reconnect();
    };
    const staleTimer = setInterval(() => {
      updateLive();
      dropIfStale(scheduleReconnect);
    }, STALE_CHECK_MS);
    // Back in the foreground: a socket that went quiet meanwhile is
    // replaced now, and a reconnect waiting out its backoff goes now.
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || disposed) return;
      dropIfStale(reconnectNow);
      if (!wsRef.current && timeoutHandle) reconnectNow();
    };
    document.addEventListener('visibilitychange', onVisible);

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
      lastMessageAt = Date.now();

      ws.addEventListener('open', () => {
        if (!reopenAfterEviction) reconnectAttemptsRef.current = 0;
        reopenAfterEviction = false;
        if (wsRef.current === ws) {
          socketOpen = true;
          lastMessageAt = Date.now();
          updateLive();
        }
        if (openedForRef.current === openScope) {
          for (const key of REOPEN_KEYS) debouncedInvalidate([key]);
          // A missed people.changed may have been about this person.
          void refreshSessionRef.current();
        }
        openedForRef.current = openScope;
      });

      ws.addEventListener('message', (e) => {
        if (wsRef.current === ws) {
          lastMessageAt = Date.now();
          updateLive();
        }
        let msg: Incoming;
        try {
          msg = JSON.parse(e.data) as Incoming;
        } catch {
          return;
        }
        switch (msg.type) {
          // HIS-6 / DX-CAT-1: see realtimeKeys.ts for what each makes stale.
          case 'order.changed':
          case 'run.changed':
          case 'catalog.changed':
          case 'attendance.changed':
            for (const key of PUSH_KEYS[msg.type]) debouncedInvalidate([key]);
            break;
          case 'people.changed':
            for (const key of PUSH_KEYS[msg.type]) debouncedInvalidate([key]);
            // ADM-24 (2026-10-30): the change may be to this person's own
            // roles; re-read the session so tabs and pages follow it
            // instead of failing on the next request.
            void refreshSessionRef.current();
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
        const current = wsRef.current === ws;
        if (current) {
          wsRef.current = null;
          socketOpen = false;
          updateLive();
        }
        // A socket dropped as stale was replaced already (COREWEB2-07).
        if (disposed || !current) return;
        if (ev.code === WS_CLOSE_EVICTED) reopenAfterEviction = true;
        switch (afterClose(ev.code)) {
          case 'refreshToken':
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
          case 'readSession':
            // A session that changed (another workspace, a new token)
            // re-runs this effect; pages poll meanwhile.
            void refreshSessionRef.current();
            return;
          case 'reconnect':
            scheduleReconnect();
        }
      });
      ws.addEventListener('error', () => {
        // Browsers fire close after error; rely on close handler.
      });
    };

    const scheduleReconnect = () => {
      if (disposed || stoppedRef.current) return;
      const attempt = ++reconnectAttemptsRef.current;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
      timeoutHandle = setTimeout(() => {
        timeoutHandle = null;
        connect();
      }, delay);
    };
    const reconnectNow = () => {
      if (disposed || stoppedRef.current) return;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      timeoutHandle = null;
      connect();
    };

    connect();

    return () => {
      disposed = true;
      stoppedRef.current = true;
      clearInterval(staleTimer);
      document.removeEventListener('visibilitychange', onVisible);
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
