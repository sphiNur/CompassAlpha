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
import { env } from './env';
import { createApp } from './app';
import { logger } from './infra/log';
import { getDb, closeDb, inSystem, unprobed } from '@compass/db';
import { verifyAccess } from './infra/jwt';
import { hub } from './realtime/hub';
import { relayDatabaseNotices } from './realtime/dbRelay';
import { createWebSocketHandler, handleWsRequest, type WSData } from './realtime/socket';
import { loadSession } from './trpc/context';

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

  // APR-12/B14: changes the worker makes (a claim released for being
  // idle) reach open pages through Postgres NOTIFY. Without the listener
  // the app still works; those pages just refresh later.
  try {
    await relayDatabaseNotices(unprobed(db).$client);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'realtime LISTEN failed; worker changes will not be pushed',
    );
  }

  const app = createApp();

  const server = Bun.serve<WSData>({
    port: env.PORT,
    hostname: env.HOST,
    idleTimeout: 60,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === '/ws') {
        return handleWsRequest(req, server, {
          verifyAccess,
          loadSession: (userId, orgId, memberId) => loadSession(db, userId, orgId, memberId),
          onSessionLookupError: (err) =>
            logger.warn({ err: (err as Error).message }, 'ws session lookup failed'),
        });
      }
      return app.fetch(req);
    },
    websocket: createWebSocketHandler(logger),
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
