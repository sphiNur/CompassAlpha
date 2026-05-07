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

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
// Coalesce bursts of WebSocket `order.changed` / `run.changed` into one
// invalidate per quiet window. Without this, hammering the +/- button
// fans out one ws message per tap → one invalidate per tap → one
// refetch per tap → the qty visually flickers between optimistic and
// server values mid-stream.
const INVALIDATE_DEBOUNCE_MS = 400;

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
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const stoppedRef = useRef(false);

  useEffect(() => {
    if (!accessToken || !orgId) return;
    stoppedRef.current = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    // Debounced invalidate so a burst of N ws events for the same query
    // key collapses into ONE refetch after the burst settles.
    const pendingInvalidates = new Map<string, ReturnType<typeof setTimeout>>();
    const debouncedInvalidate = (queryKey: QueryKey) => {
      const id = JSON.stringify(queryKey);
      const existing = pendingInvalidates.get(id);
      if (existing) clearTimeout(existing);
      const t = setTimeout(() => {
        pendingInvalidates.delete(id);
        void queryClient.invalidateQueries({ queryKey });
      }, INVALIDATE_DEBOUNCE_MS);
      pendingInvalidates.set(id, t);
    };

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
        reconnectAttemptsRef.current = 0;
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
          case 'ping':
          default:
            break;
        }
      });

      ws.addEventListener('close', () => {
        wsRef.current = null;
        scheduleReconnect();
      });
      ws.addEventListener('error', () => {
        // Browsers fire close after error; rely on close handler.
      });
    };

    const scheduleReconnect = () => {
      if (stoppedRef.current) return;
      const attempt = ++reconnectAttemptsRef.current;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
      timeoutHandle = setTimeout(connect, delay);
    };

    connect();

    return () => {
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
