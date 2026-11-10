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
import { hub, WS_CLOSE_GOING_AWAY } from './realtime/hub';
import { relayDatabaseNotices } from './realtime/dbRelay';
import { createWebSocketHandler, handleWsRequest, type WSData } from './realtime/socket';
import { scanAttendanceReminders } from './services/attendanceReminders';
import { purgeOldAttendancePhotos, purgeOldFramePrints } from './services/attendancePhotoRetention';
import { trustedClientIp } from './services/clientIp';
import { loadSession } from './trpc/context';
import { every, settlesWithin } from './infra/periodic';

/** How long shutdown waits for requests and jobs in flight. */
const SHUTDOWN_GRACE_MS = 10_000;
const ATTENDANCE_JOB_MS = 5 * 60_000;

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
          clientIp: (r) =>
            trustedClientIp((name) => r.headers.get(name) ?? undefined, env.CLIENT_IP_PROXY_KEY),
        });
      }
      // D21: the dev-login locality check needs the socket's own peer
      // address, which only Bun.serve knows; Hono exposes it as c.env.
      return app.fetch(req, { peerIp: server.requestIP(req)?.address ?? null });
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

  // 2026-11-05: attendance reminders (forgot to clock in / out, absent →
  // managers). Each is deduped per shift, so a missed or doubled tick is
  // harmless. COREAPI-13 (2026-11-09): the photo and frame-print retention
  // ran after the scan and was skipped whenever the scan failed; each is
  // now a job of its own (infra/periodic.ts).
  const jobs = [
    every(
      'attendance reminders',
      ATTENDANCE_JOB_MS,
      async () => {
        const sent = await scanAttendanceReminders(db, new Date(), {
          onShiftError: (shiftId, err) =>
            logger.warn({ err, shiftId }, 'attendance reminder failed'),
        });
        if (sent > 0) logger.info({ sent }, 'attendance reminders');
      },
      logger,
    ),
    every(
      'attendance photo retention',
      ATTENDANCE_JOB_MS,
      async () => {
        const purged = await purgeOldAttendancePhotos(db);
        if (purged > 0) logger.info({ purged }, 'old attendance photos deleted');
      },
      logger,
    ),
    every(
      'attendance frame-print retention',
      ATTENDANCE_JOB_MS,
      async () => {
        const prints = await purgeOldFramePrints(db);
        if (prints > 0) logger.info({ prints }, 'old attendance frame prints deleted');
      },
      logger,
    ),
  ];

  logger.info({ port: server.port, host: env.HOST }, 'API listening');

  // COREAPI-14 (2026-11-09): shutdown cut every connection at once and
  // closed the database under the requests still running, so a write
  // could commit without its idempotency record (the app's retry then hit
  // requestInFlight for a minute). Now: stop taking connections, close
  // the sockets (Bun's graceful stop waits for them too; clients
  // reconnect, to the new process on a deploy), let requests and jobs in
  // flight finish, and only then cut what is left and close the database.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    clearInterval(pingInterval);
    const drained = server.stop();
    hub.closeAll(WS_CLOSE_GOING_AWAY);
    const settled = await settlesWithin(
      Promise.all([drained, ...jobs.map((job) => job.stop())]),
      SHUTDOWN_GRACE_MS,
    );
    if (!settled) {
      logger.warn({ graceMs: SHUTDOWN_GRACE_MS }, 'work still running at shutdown; cutting it');
      await server.stop(true);
    }
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
