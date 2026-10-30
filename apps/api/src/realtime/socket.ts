/**
 * The /ws endpoint: authenticates the upgrade request and wires each
 * socket into the per-org realtime hub.
 *
 * Lives outside main.ts so the handshake can be tested against a real
 * Bun.serve with stubbed auth (realtime-socket.test.ts) — main.ts only
 * plugs the real `verifyAccess` and `loadSession` in.
 */
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';
import { hub, WS_CLOSE_EVICTED } from './hub';

export interface WSData {
  orgId: string;
  userId: string;
  unsub: () => void;
  /** Access-token `exp` (epoch seconds); the socket is closed when it passes. */
  exp: number | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  /** A token-less deploy-smoke probe: closed right after the hello. */
  probe?: boolean;
}

/** Close code for a socket whose access token expired (client should refresh). */
export const WS_CLOSE_TOKEN_EXPIRED = 4001;

/**
 * Close code for a probe socket (N1, 2026-10-30).
 *
 * The deploy smoke cannot mint a production token, and every token-less
 * request used to be refused with a plain HTTP 401 *before* any upgrade —
 * which a proxy that breaks the 101 handshake (N1: the Worker re-wrapped
 * the 101 and every client fell back to polling) passes through just as
 * well as a healthy one. So the smoke "passed" with realtime dead.
 *
 * `GET /ws?probe=1` with no token is upgraded for real, sent one
 * `{"type":"probe"}` frame and closed with this code. Getting all three
 * back through the public URL proves the upgrade, a server→client frame
 * and the close frame all cross every proxy. The probe socket never joins
 * the hub, so it receives nothing about any organisation.
 */
export const WS_CLOSE_PROBE = 4002;

interface Claims {
  sub: string;
  org: string;
  mid: string;
  exp?: number;
}

export interface SocketDeps {
  verifyAccess: (token: string) => Promise<Claims>;
  /** Resolves the member's live session; null when not an active member. */
  loadSession: (userId: string, orgId: string, memberId: string) => Promise<unknown>;
  onSessionLookupError?: (err: unknown) => void;
}

function isUpgradeRequest(req: Request): boolean {
  return (req.headers.get('upgrade') ?? '').toLowerCase() === 'websocket';
}

/**
 * Handle a request for /ws. Returns `undefined` when the request was
 * upgraded (Bun then owns the connection), otherwise the refusal.
 */
export async function handleWsRequest(
  req: Request,
  server: Server<WSData>,
  deps: SocketDeps,
): Promise<Response | undefined> {
  const url = new URL(req.url);
  // RE-ENG-4 (2026-10-30): a plain GET (no Upgrade header) with a valid
  // token got all the way to server.upgrade(), which refused it, and was
  // answered 500 "upgrade failed" — a server error for a client mistake.
  // Answer before the token and the DB lookup are spent on it.
  if (!isUpgradeRequest(req)) {
    return new Response('websocket upgrade required', {
      status: 426,
      headers: { upgrade: 'websocket', connection: 'Upgrade' },
    });
  }
  // Auth via short-lived ?token=<jwt>; we accept the same access
  // token the SPA uses for tRPC (M2 will replace with a dedicated
  // ws-ticket procedure).
  const token = url.searchParams.get('token') ?? '';
  if (!token) {
    if (url.searchParams.get('probe') === '1') {
      const probeData: WSData = {
        orgId: '',
        userId: '',
        unsub: () => {},
        exp: null,
        expiryTimer: null,
        probe: true,
      };
      if (server.upgrade(req, { data: probeData })) return undefined;
      return new Response('bad websocket handshake', { status: 400 });
    }
    return new Response('missing token', { status: 401 });
  }
  let claims: Claims;
  try {
    claims = await deps.verifyAccess(token);
  } catch {
    return new Response('bad token', { status: 401 });
  }
  // 2026-10-21 audit CA-35/F-08: a valid signature is not enough —
  // a member suspended or removed within the token's lifetime could
  // still open a socket and receive org-wide change events. Same
  // check every tRPC request makes (trpc/context.ts).
  let session;
  try {
    session = await deps.loadSession(claims.sub, claims.org, claims.mid);
  } catch (err) {
    deps.onSessionLookupError?.(err);
    return new Response('session lookup failed', { status: 503 });
  }
  if (!session) return new Response('no active membership', { status: 403 });
  const data: WSData = {
    orgId: claims.org,
    userId: claims.sub,
    unsub: () => {},
    exp: typeof claims.exp === 'number' ? claims.exp : null,
    expiryTimer: null,
  };
  if (server.upgrade(req, { data })) return undefined;
  // Upgrade header present but the handshake itself is malformed
  // (no Sec-WebSocket-Key, wrong version): still the client's fault.
  return new Response('bad websocket handshake', { status: 400 });
}

export function createWebSocketHandler(log: {
  debug: (obj: object, msg: string) => void;
}): WebSocketHandler<WSData> {
  return {
    open(ws: ServerWebSocket<WSData>) {
      if (ws.data.probe) {
        ws.send(JSON.stringify({ type: 'probe', t: Date.now() }));
        ws.close(WS_CLOSE_PROBE, 'probe');
        return;
      }
      ws.data.unsub = hub.subscribe(
        ws.data.orgId,
        (data) => ws.send(data),
        () => ws.close(WS_CLOSE_EVICTED, 'evicted'),
      );
      // CA-35/F-08: the socket lives no longer than the token it was
      // opened with; the client reconnects with a fresh one.
      if (ws.data.exp !== null) {
        const ms = Math.max(0, ws.data.exp * 1000 - Date.now());
        ws.data.expiryTimer = setTimeout(
          () => ws.close(WS_CLOSE_TOKEN_EXPIRED, 'token expired'),
          ms,
        );
      }
      // M3.9: demoted from info → debug. Active deploys see dozens of
      // WS open/close events per minute as clients reconnect; at info
      // level they dominate journalctl and hide real signals. The
      // info we log here (orgId/userId/subs count) is recoverable
      // from connection metrics if needed.
      log.debug(
        { orgId: ws.data.orgId, userId: ws.data.userId, subs: hub.size(ws.data.orgId) },
        'ws open',
      );
      // Send an initial hello so the client knows the channel is live.
      ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
    },
    message(ws: ServerWebSocket<WSData>, raw) {
      // M1 has no client→server messages; just pong on ping.
      if (ws.data.probe) return;
      try {
        const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
        if (msg?.type === 'ping') ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
      } catch {
        /* ignore malformed */
      }
    },
    close(ws: ServerWebSocket<WSData>) {
      if (ws.data.expiryTimer) clearTimeout(ws.data.expiryTimer);
      ws.data.unsub();
      if (ws.data.probe) return;
      log.debug(
        { orgId: ws.data.orgId, userId: ws.data.userId, subs: hub.size(ws.data.orgId) },
        'ws close',
      );
    },
  };
}
