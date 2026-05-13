import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { trpcServer } from '@hono/trpc-server';
import { sql } from 'drizzle-orm';
import { getDb } from '@compass/db';
import { env } from './env';
import { logger } from './infra/log';
import { appRouter } from './trpc/router';
import { createContext } from './trpc/context';

/**
 * Read the web build's id (emitted by vite.config.ts → buildShaPlugin)
 * from disk at every /health/version call. Cheaper than a full re-read of
 * env every time, and stays correct across hot deploys without restarting
 * the API. Returns the longest-living valid value among:
 *   1. apps/web/dist/build-id.txt (newest)
 *   2. process.env.VITE_BUILD_SHA
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
  return process.env.VITE_BUILD_SHA ?? 'dev';
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
   *   Permissions-Policy: deny-all-by-default
   *     We don't ask for camera/mic/geolocation/etc. Blocking them at
   *     the header level prevents an injected library from silently
   *     prompting the user.
   *
   * NOT setting CSP yet:
   *   Vite's HMR + Telegram's WebView + tRPC's eval-free runtime
   *   together require a precise CSP that has historically broken
   *   the dev loop. Land in M1 with a tested allow-list.
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
        'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
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
          "script-src 'self'",
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
        c.header(
          'Strict-Transport-Security',
          'max-age=31536000; includeSubDomains; preload',
        );
      }
    }
  });

  app.use(
    '*',
    cors({
      origin: (origin) => {
        if (!origin) return env.FRONTEND_URL;
        if (origin === env.FRONTEND_URL) return origin;
        // Telegram WebView + Cloudflare tunnels
        if (
          origin === 'https://web.telegram.org' ||
          origin.endsWith('.telegram.org') ||
          origin === 'https://t.me' ||
          origin.endsWith('.trycloudflare.com')
        ) {
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
  /**
   * Readiness probe — meant for load-balancer health checks. Distinguishes
   * "process alive" (live) from "able to serve real traffic" (ready).
   *
   * Hardened 2026-05-05 (audit finding): the previous implementation just
   * returned `{status:'ok'}` unconditionally, so a load balancer would
   * happily route traffic to an instance whose Postgres connection had
   * died. Now we actively check:
   *   1. DB roundtrip — `SELECT 1`. Must succeed within ~2s.
   *   2. Projector cursor lag — read read-model `last_seq` vs current
   *      max event id. If lag > 5s wall-clock, we still return ready
   *      (read-model is just stale, not broken) but flag it so
   *      observability surfaces it.
   *
   * On any DB failure → 503. The LB treats this as "drain me, route
   * traffic elsewhere" (in single-replica setups, it just means the
   * smoke alerts). The 503 body still surfaces what failed so
   * `scripts/deploy.ts` can pretty-print the cause.
   */
  app.get('/health/ready', async (c) => {
    const dbStart = Date.now();
    try {
      await getDb(env.DATABASE_URL).execute(sql`SELECT 1`);
    } catch (err) {
      logger.error({ err }, '/health/ready DB ping failed');
      return c.json(
        { status: 'down', component: 'db', error: (err as Error).message },
        503,
      );
    }
    const dbMs = Date.now() - dbStart;

    // Projector lag — non-fatal. Compute "max event time vs latest cursor
    // last_event_occurred_at" if the cursor table exists. Wrap in
    // try/catch because the table might be empty in fresh prod.
    let projectorLagMs: number | null = null;
    try {
      const r = await getDb(env.DATABASE_URL).execute(sql`
        SELECT EXTRACT(EPOCH FROM (NOW() - MAX(last_event_occurred_at))) * 1000 AS lag_ms
        FROM domain.projector_cursors
      `);
      const lag = (r as unknown as Array<{ lag_ms: number | null }>)[0]?.lag_ms;
      projectorLagMs = lag != null ? Math.max(0, Math.round(lag)) : null;
    } catch {
      /* cursor table empty or missing — not fatal */
    }

    return c.json({
      status: 'ok',
      version: readWebBuildId(),
      dbMs,
      projectorLagMs,
    });
  });
  app.get('/health/version', (c) =>
    c.json({
      commit: readWebBuildId(),
      apiStartedAt: STARTED_AT,
      // Kept for back-compat with the earlier /version client.
      startedAt: STARTED_AT,
    }),
  );

  // @hono/trpc-server's createContext typing is `Record<string, unknown>` —
  // narrower than our shaped RequestContext. Cast at the boundary.
  app.use(
    '/trpc/*',
    trpcServer({
      router: appRouter,
      createContext: createContext as unknown as Parameters<typeof trpcServer>[0]['createContext'],
    }),
  );

  // Static SPA fallback (only in prod, where we serve dist/web from same process).
  // Wired via Caddy in dev; here we just 404 unknown paths.
  app.notFound((c) => c.json({ code: 'NOT_FOUND', i18nKey: 'common.notFound' }, 404));

  app.onError((err, c) => {
    logger.error({ err }, 'unhandled error');
    return c.json({ code: 'INTERNAL', i18nKey: 'common.errors.internal' }, 500);
  });

  return app;
}

const STARTED_AT = new Date().toISOString();
