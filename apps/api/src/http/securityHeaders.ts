/**
 * The security headers on every response and the CORS origin rule, out of
 * app.ts so a test can check them without the database or the env.
 */
import type { MiddlewareHandler } from 'hono';
import { CSP_REPORT_PATH } from './cspReport';

/** The directives both policies share (see the enforced one below). */
const SCRIPT_SRC = "script-src 'self' 'wasm-unsafe-eval' https://telegram.org";
const BEFORE_CONNECT = [
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
];
const AFTER_CONNECT = [
  "frame-ancestors 'self' https://web.telegram.org https://t.me",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
];

/** The Reporting API endpoint name the report-only policy reports to. */
export const CSP_REPORT_GROUP = 'csp';

/** A Host header that is a plain host[:port], or null. */
function plainHost(value: string | undefined): string | null {
  const host = value?.trim().toLowerCase();
  return host && /^[a-z0-9.-]+(?::\d{1,5})?$/.test(host) ? host : null;
}

/**
 * Reviews MWD-12 / MWD-13 (modern-web-guidance: security, trusted-types):
 * the policy sent as `Content-Security-Policy`. It ran report-only first
 * (2026-11-14) beside a looser enforced one; once the reports were clean
 * it replaced it. A browser still reports what it blocks to POST
 * /csp-report (cspReport.ts). What it adds:
 *
 *   - connect-src  'self', the page's own host over wss (the realtime
 *                  socket; older WebKit does not match ws to 'self'),
 *                  the photo bucket's origin (the presigned PUT, from
 *                  S3_ENDPOINT / S3_BUCKET) and Telegram, instead of any
 *                  https: or wss: host. In production the web calls the
 *                  api on its own origin (VITE_API_URL and VITE_WS_URL
 *                  are empty), through the Worker.
 *   - script-src   'report-sample', so a report shows what ran.
 *   - require-trusted-types-for 'script' with two policy names. The app
 *                  has no HTML sinks of its own; its script URLs (the
 *                  service worker, workers, the face tracker's wasm
 *                  loader, which MediaPipe sets on a `<script src>` from a
 *                  string) pass the web's `default` policy
 *                  (apps/web/src/lib/trustedTypes.ts: same-origin /assets
 *                  and /sw.js only). `goog#html` is the pass-through policy
 *                  MediaPipe creates for itself; allowing the name keeps
 *                  its createPolicy from throwing once this is enforced.
 *                  Any other policy name is refused.
 *   - report-uri and report-to (Reporting-Endpoints), both to
 *                  /csp-report.
 */
export function strictCsp({
  connectOrigins,
  host,
}: {
  /** Origins the page really connects to besides its own (the bucket). */
  connectOrigins: readonly string[];
  /** The page's own host, from the request; null when unusable. */
  host: string | null;
}): string {
  const connect = ["'self'"];
  if (host) connect.push(`wss://${host}`);
  for (const origin of connectOrigins) if (!connect.includes(origin)) connect.push(origin);
  connect.push('https://telegram.org');
  return [
    "default-src 'self'",
    `${SCRIPT_SRC} 'report-sample'`,
    ...BEFORE_CONNECT,
    `connect-src ${connect.join(' ')}`,
    ...AFTER_CONNECT,
    "require-trusted-types-for 'script'",
    'trusted-types default goog#html',
    `report-uri ${CSP_REPORT_PATH}`,
    `report-to ${CSP_REPORT_GROUP}`,
  ].join('; ');
}

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
 *   No X-Frame-Options (review MWD-16, modern-web-guidance: security)
 *     Letting third-party sites frame us would enable clickjacking
 *     ("approve this order!" overlaid invisibly on a Reject button), so
 *     CSP `frame-ancestors` names who may: our own host and Telegram.
 *     Telegram Web (web.telegram.org) does frame the Mini App, and the
 *     `X-Frame-Options: SAMEORIGIN` sent beside it blocked that embed in
 *     any client that reads only the older header. The guide: with a
 *     cross-origin `frame-ancestors`, omit X-Frame-Options.
 *
 *   Cross-Origin-Opener-Policy: same-origin-allow-popups (HTML only)
 *     Review MWD-19 (modern-web-guidance: security): a cross-origin page
 *     that opens this one gets no handle on it. The app talks to no
 *     popup: Telegram links go through the SDK (openLink,
 *     openTelegramLink), the invite share outside Telegram is a
 *     fire-and-forget window.open (allowed popups keep working), and
 *     nothing reads window.opener. A framed document ignores COOP, so
 *     the Telegram Web embed is unaffected.
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
export function securityHeaders({
  production,
  connectOrigins = [],
}: {
  production: boolean;
  /** MWD-12: origins the page connects to besides its own (report-only policy). */
  connectOrigins?: readonly string[];
}): MiddlewareHandler {
  return async (c, next) => {
    // try/finally so headers also land on error responses (a thrown
    // route ends up in `app.onError` which still serializes the
    // response; without the finally, the security headers would be
    // missing exactly when an attacker is most interested in the
    // shape of the error). Audit fix 2026-05-05.
    try {
      await next();
    } finally {
      c.header('X-Content-Type-Options', 'nosniff');
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
       *   - connect-src 'self' wss://<host> <bucket> https://telegram.org
       *                                    tRPC + WebSocket on the
       *                                    page's own host (MWD-12;
       *                                    was any https:/wss: host)
       *   - require-trusted-types-for 'script', trusted-types default
       *     goog#html                     (MWD-13; strictCsp above)
       *   - frame-ancestors 'self' https://web.telegram.org https://t.me
       *                                    only Telegram can embed
       *                                    the Mini App
       *   - base-uri 'self'                blocks <base href=...>
       *                                    injection that would
       *                                    rewrite all relative URLs
       *   - form-action 'self'             no cross-origin form posts
       *   - object-src 'none'              no Flash / plugin embeds
       *
       * `frame-ancestors` is the only framing rule sent (MWD-16, above).
       */
      // Reviews MWD-12 / MWD-13 (modern-web-guidance: security,
      // trusted-types): the strict policy (strictCsp above), enforced
      // after it ran report-only with clean reports. Blocked items still
      // report to /csp-report. The Telegram SDK (MWD-11, owner decision
      // 2026-11-14) stays the one external script; 'wasm-unsafe-eval' is
      // the face tracker's WebAssembly, not eval().
      c.header(
        'Content-Security-Policy',
        strictCsp({
          connectOrigins,
          host: plainHost(c.req.header('x-forwarded-host') ?? c.req.header('host')),
        }),
      );
      c.header('Reporting-Endpoints', `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`);
      if (production) {
        c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
      }
      // MWD-19: on the pages only (index.html), not on the JSON.
      if ((c.res.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html')) {
        c.header('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
      }
    }
  };
}

/**
 * The page origins allowed to call the api from another origin, with
 * credentials. Review MWD-17 (modern-web-guidance: validate-origins): the
 * origin is parsed with `URL`, never matched with `endsWith` on the raw
 * string, which also let `http://` origins through. Telegram's are
 * `https:` with a hostname under `telegram.org`, or `t.me`.
 */
export function allowedCorsOrigin(
  origin: string,
  { frontendUrl, production }: { frontendUrl: string; production: boolean },
): string | null {
  if (origin === frontendUrl) return origin;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  // An Origin header is a bare origin: no path, query or credentials.
  if (url.origin !== origin) return null;
  const host = url.hostname;
  // Telegram WebView origins — production + first-party only.
  if (url.protocol === 'https:' && (host.endsWith('.telegram.org') || host === 't.me')) {
    return origin;
  }
  if (production) return null;
  // Cloudflare quick-tunnels are a dev/staging convenience —
  // NEVER trust them in production (any developer can spin one
  // up and forge our Origin). M3.18 hardening, 2026-05-16.
  if (url.protocol === 'https:' && host.endsWith('.trycloudflare.com')) return origin;
  const local = host === 'localhost' || host === '127.0.0.1';
  if (local && (url.protocol === 'http:' || url.protocol === 'https:')) return origin;
  return null;
}
