/**
 * API entrypoint.
 *
 * `bun run --watch src/main.ts` starts a Hono server with tRPC + WS.
 *
 * Bun.serve is used directly (not @hono/node-server) — Bun's native server
 * is faster and doesn't fight Bun's HTTP runtime semantics.
 *
 * The Bun.serve config combines:
 *   - `fetch` for regular HTTP traffic (Hono → tRPC)
 *   - `upgrade()` to handle /ws upgrades (Bun's native websockets API)
 *   - `websocket` lifecycle (open/message/close) wires the connection into
 *     the per-org realtime hub
 */
import { sql } from 'drizzle-orm';
import type { ServerWebSocket } from 'bun';
import { env } from './env';
import { createApp } from './app';
import { logger } from './infra/log';
import { getDb, closeDb, inSystem } from '@compass/db';
import { verifyAccess } from './infra/jwt';
import { hub, WS_CLOSE_EVICTED } from './realtime/hub';
import { loadSession } from './trpc/context';

interface WSData {
  orgId: string;
  userId: string;
  unsub: () => void;
  /** Access-token `exp` (epoch seconds); the socket is closed when it passes. */
  exp: number | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

/** Close code for a socket whose access token expired (client should refresh). */
const WS_CLOSE_TOKEN_EXPIRED = 4001;

async function main() {
  const db = getDb(env.DATABASE_URL);
  try {
    await inSystem(db, 'health', (tx) => tx.execute(sql`SELECT 1`));
    logger.info('DB ping ok');
  } catch (err) {
    if (env.NODE_ENV === 'production') {
      logger.error({ err }, 'DB ping failed; refusing to start');
      process.exit(1);
    }
    logger.warn({ err: (err as Error).message }, 'DB ping failed; continuing in dev');
  }

  const app = createApp();

  const server = Bun.serve<WSData>({
    port: env.PORT,
    hostname: env.HOST,
    idleTimeout: 60,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === '/ws') {
        // Auth via short-lived ?token=<jwt>; we accept the same access
        // token the SPA uses for tRPC (M2 will replace with a dedicated
        // ws-ticket procedure).
        const token = url.searchParams.get('token') ?? '';
        if (!token) return new Response('missing token', { status: 401 });
        let claims;
        try {
          claims = await verifyAccess(token);
        } catch {
          return new Response('bad token', { status: 401 });
        }
        // 2026-10-21 audit CA-35/F-08: a valid signature is not enough —
        // a member suspended or removed within the token's lifetime could
        // still open a socket and receive org-wide change events. Same
        // check every tRPC request makes (trpc/context.ts).
        let session;
        try {
          session = await loadSession(db, claims.sub, claims.org, claims.mid);
        } catch (err) {
          logger.warn({ err: (err as Error).message }, 'ws session lookup failed');
          return new Response('session lookup failed', { status: 503 });
        }
        if (!session) return new Response('no active membership', { status: 403 });
        const exp = (claims as { exp?: number }).exp;
        const upgraded = server.upgrade(req, {
          data: {
            orgId: claims.org,
            userId: claims.sub,
            unsub: () => {},
            exp: typeof exp === 'number' ? exp : null,
            expiryTimer: null,
          } as WSData,
        });
        if (upgraded) return undefined;
        return new Response('upgrade failed', { status: 500 });
      }
      return app.fetch(req);
    },
    websocket: {
      open(ws: ServerWebSocket<WSData>) {
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
        logger.debug(
          { orgId: ws.data.orgId, userId: ws.data.userId, subs: hub.size(ws.data.orgId) },
          'ws open',
        );
        // Send an initial hello so the client knows the channel is live.
        ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
      },
      message(ws: ServerWebSocket<WSData>, raw) {
        // M1 has no client→server messages; just pong on ping.
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
        logger.debug(
          { orgId: ws.data.orgId, userId: ws.data.userId, subs: hub.size(ws.data.orgId) },
          'ws close',
        );
      },
    },
    error(err) {
      logger.error({ err }, 'Bun.serve error');
      return new Response('Internal error', { status: 500 });
    },
  });

  // Periodic ping so idle connections don't get dropped by edge proxies
  // (Cloudflare / nginx will close idle WebSockets after ~60s).
  // M3.8 (2026-05-15): previously empty body — was a known gap from the
  // hub's initial design where there was no broadcast-all primitive.
  // hub.pingAll() now sends a `{type:'ping', t}` frame to every sink
  // across every org. 25s cadence keeps the connection well below
  // typical proxy idle timeouts. The hub returns the count for the
  // optional debug log, useful when chasing reconnect storms.
  const pingInterval = setInterval(() => {
    const total = hub.size();
    if (total === 0) return;
    const pinged = hub.pingAll();
    // Logging at debug-level avoids noise on healthy clusters. Bump
    // to info if you need to verify the path in production.
    logger.debug({ pinged, totalSubs: total }, 'ws pingAll');
  }, 25_000);
  pingInterval.unref?.();

  logger.info({ port: server.port, host: env.HOST }, 'API listening');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    clearInterval(pingInterval);
    server.stop(true);
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
