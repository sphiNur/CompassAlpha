import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { trpcServer } from '@hono/trpc-server';
import { sql } from 'drizzle-orm';
import { getDb, inSystem } from '@compass/db';
import { env } from './env';
import { logger } from './infra/log';
import { appRouter } from './trpc/router';
import { createContext } from './trpc/context';
import { attendanceMonthExport } from './http/attendanceExport';
import { INTERNAL_BODY, NOT_FOUND_BODY } from './http/errorBodies';
import { readinessHandler } from './http/health';
import { allowedCorsOrigin, securityHeaders } from './http/securityHeaders';
import { serveWebApp } from './http/webApp';

/**
 * Read the web build's id (emitted by vite.config.ts → buildShaPlugin)
 * from disk at every /health/version call. Cheaper than a full re-read of
 * env every time, and stays correct across hot deploys without restarting
 * the API. Returns the longest-living valid value among:
 *   1. apps/web/dist/build-id.txt (newest)
 *   2. VITE_BUILD_SHA from the environment
 *   3. 'dev' fallback
 */
function readWebBuildId(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(__dirname, '..', '..', 'web', 'dist', 'build-id.txt'),
    join(__dirname, '..', '..', '..', 'apps', 'web', 'dist', 'build-id.txt'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        return readFileSync(path, 'utf8').trim();
      } catch {
        /* fall through */
      }
    }
  }
  return env.VITE_BUILD_SHA ?? 'dev';
}

export function createApp() {
  const app = new Hono();

  // Security headers on every response (http/securityHeaders.ts).
  app.use('*', securityHeaders({ production: env.NODE_ENV === 'production' }));

  app.use(
    '*',
    cors({
      origin: (origin) => {
        if (!origin) return env.FRONTEND_URL;
        // Review MWD-17 (modern-web-guidance: validate-origins): parsed,
        // scheme and hostname checked (http/securityHeaders.ts).
        const allowed = allowedCorsOrigin(origin, {
          frontendUrl: env.FRONTEND_URL,
          production: env.NODE_ENV === 'production',
        });
        if (allowed === null) logger.warn({ origin }, 'CORS denied');
        return allowed;
      },
      credentials: true,
      allowHeaders: [
        'Authorization',
        'Content-Type',
        'X-Idempotency-Key',
        'X-Trace-Id',
        'X-Compass-Org',
      ],
    }),
  );

  app.get('/health/live', (c) => c.json({ status: 'ok' }));
  // Readiness: one database round trip (http/health.ts).
  app.get(
    '/health/ready',
    readinessHandler({
      pingDb: () => inSystem(getDb(env.DATABASE_URL), 'health', (tx) => tx.execute(sql`SELECT 1`)),
      version: readWebBuildId,
      onDbError: (err) => logger.error({ err }, '/health/ready DB ping failed'),
    }),
  );
  app.get('/health/version', (c) =>
    c.json({
      commit: readWebBuildId(),
      apiStartedAt: STARTED_AT,
      // Kept for back-compat with the earlier /version client.
      startedAt: STARTED_AT,
    }),
  );

  // Attendance month spreadsheet behind a signed, five-minute link.
  app.get('/files/attendance-month.xlsx', attendanceMonthExport);

  // @hono/trpc-server's createContext typing is `Record<string, unknown>` —
  // narrower than our shaped RequestContext. Cast at the boundary.
  app.use(
    '/trpc/*',
    trpcServer({
      router: appRouter,
      createContext: createContext as unknown as Parameters<typeof trpcServer>[0]['createContext'],
      // The client only gets a generic key for these (trpc.ts
      // errorFormatter), so this log is the one place the cause is kept.
      // Refusals (attendance's included, 2026-11-07) are logged by the
      // procedures' own middleware (trpc.ts logFailedCall).
      onError({ error, path, type }) {
        if (error.code === 'INTERNAL_SERVER_ERROR') {
          logger.error({ err: error.cause ?? error, path, type }, 'trpc internal error');
        }
      },
    }),
  );

  /**
   * SPA static serving (M3.18, launch hardening 2026-05-16).
   *
   * Earlier comment promised "serve dist/web from same process" but
   * the implementation was missing — every path under / fell into
   * notFound() and returned JSON, leaving the SPA inaccessible.
   *
   * Resolution: serve apps/web/dist as static assets, then for any
   * GET that doesn't match a real file, return index.html so the
   * SPA's client-side router can take over (deep-linked URLs like
   * /order, /admin, /run all work on a hard refresh).
   *
   * The api runs from its source (apps/api/src/main.ts, in production
   * too; review COREAPI-28 removed the unused dist build), and the web
   * bundle is apps/web/dist beside it.
   *
   * If neither path exists (e.g., api running standalone in CI), we
   * skip and let notFound() handle it — the existing dev workflow
   * where Vite serves :5173 separately keeps working.
   */
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const webDistCandidates = [
    join(__dirname, '..', '..', 'web', 'dist'),
    join(__dirname, '..', '..', '..', 'apps', 'web', 'dist'),
  ];
  const webDist = webDistCandidates.find((p) => existsSync(join(p, 'index.html')));
  if (webDist) {
    logger.info({ webDist }, 'SPA static serving enabled');
    serveWebApp(app, webDist);
  } else {
    logger.warn(
      { tried: webDistCandidates },
      'apps/web/dist not found; SPA serving disabled (dev workflow uses Vite on :5173)',
    );
  }

  // Last-resort notFound — only hit when SPA serving is disabled
  // (CI / dev without built web) or for paths /trpc/* didn't claim.
  app.notFound((c) => c.json(NOT_FOUND_BODY, 404));

  app.onError((err, c) => {
    logger.error({ err }, 'unhandled error');
    return c.json(INTERNAL_BODY, 500);
  });

  return app;
}

const STARTED_AT = new Date().toISOString();
