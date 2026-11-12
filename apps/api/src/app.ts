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

  /**
   * Security headers (added 2026-05-05 — pre-launch hardening).
   *
   * Why each one:
   *
   *   X-Content-Type-Options: nosniff
   *     Stops the browser from MIME-sniffing a JSON response into HTML
   *     and executing it. Cheap defense against reflected-XSS via
   *     `data:` or content-type-confused proxies.
   *
   *   X-Frame-Options: SAMEORIGIN
   *     The Mini App lives inside Telegram WebView (which uses an
   *     iframe). Letting third-party sites frame us would enable
   *     clickjacking ("approve this order!" overlaid invisibly on a
   *     Reject button). SAMEORIGIN allows our own host to frame the
   *     SPA for development; Telegram's WebView does NOT cross this
   *     boundary because it loads pages full-window with its own
   *     chrome.
   *
   *   Strict-Transport-Security
   *     Production-only — forces HTTPS for 1 year + preload eligible.
   *     We skip in dev where Vite serves HTTP locally.
   *
   *   Referrer-Policy: strict-origin-when-cross-origin
   *     Don't leak the full URL (which can carry session-ish bits in
   *     the path) to third-party origins. Same-origin still gets the
   *     full referrer — needed for our own analytics if we add it.
   *
   *   Permissions-Policy
   *     Everything off except the camera (clock-in photos) and location
   *     (the clock-in radius), and those for our own page only, so an
   *     injected library cannot prompt the user for them.
   *
   *   Content-Security-Policy: see below (M1.20).
   */
  app.use('*', async (c, next) => {
    // try/finally so headers also land on error responses (a thrown
    // route ends up in `app.onError` which still serializes the
    // response; without the finally, the security headers would be
    // missing exactly when an attacker is most interested in the
    // shape of the error). Audit fix 2026-05-05.
    try {
      await next();
    } finally {
      c.header('X-Content-Type-Options', 'nosniff');
      c.header('X-Frame-Options', 'SAMEORIGIN');
      c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
      c.header(
        'Permissions-Policy',
        // Camera for clock-in photos and location for the clock-in radius
        // (2026-11-05); our own page only.
        'camera=(self), microphone=(), geolocation=(self), payment=(), usb=()',
      );
      /**
       * M1.20 (2026-05-08, launch hardening): Content-Security-Policy.
       *
       * The API serves JSON for tRPC and the SPA HTML shell for the
       * web bundle. Both want a strict CSP to prevent injected
       * `<script>` from exfiltrating tokens or making cross-origin
       * fetches to an attacker's server.
       *
       * Directives:
       *   - default-src 'self'             same-origin assets only
       *   - script-src 'self'              no inline scripts (the
       *                                    Vite bundle is hashed
       *                                    same-origin)
       *   - style-src 'self' 'unsafe-inline'
       *                                    Tailwind injects
       *                                    style attributes; safe
       *                                    because attacker can't
       *                                    inject DOM into our SPA
       *   - img-src 'self' data: blob: https:
       *                                    receipt photos uploaded
       *                                    to S3 (https), camera
       *                                    capture (blob), inline
       *                                    SVG icons (data)
       *   - connect-src 'self' wss: https:
       *                                    tRPC + WebSocket. Allow
       *                                    https/wss broadly because
       *                                    the Cloudflare tunnel URL
       *                                    rotates during dev.
       *   - frame-ancestors 'self' https://web.telegram.org https://t.me
       *                                    only Telegram can embed
       *                                    the Mini App
       *   - base-uri 'self'                blocks <base href=...>
       *                                    injection that would
       *                                    rewrite all relative URLs
       *   - form-action 'self'             no cross-origin form posts
       *   - object-src 'none'              no Flash / plugin embeds
       *
       * `frame-ancestors` overrides the older `X-Frame-Options` —
       * keeping both for legacy crawler compatibility but the CSP
       * directive is the active one in modern browsers.
       */
      c.header(
        'Content-Security-Policy',
        [
          "default-src 'self'",
          // M3.18 (launch hardening): allow the Telegram WebApp SDK
          // (https://telegram.org/js/telegram-web-app.js) loaded from
          // index.html. The SDK is the only external script we run.
          // Inline scripts and inline event handlers were eliminated
          // in the same milestone (boot guard externalized to
          // /boot-guard.js) so we DO NOT need 'unsafe-inline'.
          // 'wasm-unsafe-eval': the liveness face tracker (MediaPipe,
          // WebAssembly from our own /assets) compiles in the page
          // (2026-11-06). It allows WebAssembly only, not eval().
          "script-src 'self' 'wasm-unsafe-eval' https://telegram.org",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob: https:",
          "font-src 'self' data:",
          "connect-src 'self' wss: https:",
          "frame-ancestors 'self' https://web.telegram.org https://t.me",
          "base-uri 'self'",
          "form-action 'self'",
          "object-src 'none'",
        ].join('; '),
      );
      if (env.NODE_ENV === 'production') {
        c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
      }
    }
  });

  app.use(
    '*',
    cors({
      origin: (origin) => {
        if (!origin) return env.FRONTEND_URL;
        if (origin === env.FRONTEND_URL) return origin;
        // Telegram WebView origins — production + first-party only.
        if (
          origin === 'https://web.telegram.org' ||
          origin.endsWith('.telegram.org') ||
          origin === 'https://t.me'
        ) {
          return origin;
        }
        // Cloudflare quick-tunnels are a dev/staging convenience —
        // NEVER trust them in production (any developer can spin one
        // up and forge our Origin). M3.18 hardening, 2026-05-16.
        if (env.NODE_ENV !== 'production' && origin.endsWith('.trycloudflare.com')) {
          return origin;
        }
        if (env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)/.test(origin)) {
          return origin;
        }
        logger.warn({ origin }, 'CORS denied');
        return null;
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
   * The path resolution tolerates two layouts:
   *   - bun-built monorepo: apps/api/dist/main.js + apps/web/dist/
   *   - dev: apps/api/src/main.ts run with apps/web at sibling
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
