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
import { useEffect, useRef } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useAuthStore } from '../stores/authStore';
import { trpc } from '../lib/trpc';

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
// 2026-10-21 audit CA-35: close codes the API's WS layer uses.
const WS_CLOSE_EVICTED = 4000;
const WS_CLOSE_TOKEN_EXPIRED = 4001;
/** Query-key roots refreshed when the socket re-opens (CA-35). */
const REOPEN_INVALIDATE_KEYS = ['order', 'run', 'catalog', 'admin', 'notifications'] as const;

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
        const waitForLocalWrites =
          queryClient.isMutating() > 0 &&
          Date.now() - startedAt < MUTATION_QUIET_MAX_WAIT_MS;
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
        if (hasOpened) {
          for (const key of REOPEN_INVALIDATE_KEYS) debouncedInvalidate([[key]]);
        }
        hasOpened = true;
      });

      ws.addEventListener('message', (e) => {
        let msg: RealtimeMessage;
        try {
          msg = JSON.parse(e.data) as RealtimeMessage;
        } catch {
          return;
        }
        switch (msg.type) {
          case 'order.changed':
            debouncedInvalidate([['order']]);
            break;
          case 'run.changed':
            debouncedInvalidate([['run']]);
            break;
          case 'catalog.changed':
            // Catalog changes ripple into many admin queries AND into
            // the public-ish catalog queries used by OrderPage etc.
            // Hit both: any tRPC procedure starting with `admin.` AND
            // the `catalog.*` ones used by the order screen.
            debouncedInvalidate([['admin']]);
            debouncedInvalidate([['catalog']]);
            break;
          case 'people.changed':
            // Member / role binding / store assignment changes.
            // The admin people page reads multiple list queries; one
            // coarse `[admin]` invalidation covers them all.
            debouncedInvalidate([['admin']]);
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
        if (wsRef.current === ws) wsRef.current = null;
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
      if (timeoutHandle) clearTimeout(timeoutHandle);
      pendingInvalidates.forEach((t) => clearTimeout(t));
      pendingInvalidates.clear();
      const ws = wsRef.current;
      if (ws && ws.readyState <= 1) ws.close(1000, 'unmount');
      wsRef.current = null;
    };
  }, [accessToken, orgId, queryClient]);
}
