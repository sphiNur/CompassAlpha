import type { Hono } from 'hono';
import { serveStatic } from 'hono/bun';

/**
 * The built web app in `webDist`: its files, then index.html for any
 * other GET, so the React router takes over (deep links work on a hard
 * refresh). tRPC and /health/* are mounted before this, so they never get
 * here.
 *
 * Review OPS-14 (2026-11): except under /assets/. A hashed file that is
 * not there is a 404. It used to be index.html with a 200, and the edge
 * Worker keeps the tracker's .wasm and model in KV for good: one request
 * for a hash this release does not have would have put the page in their
 * place, and face clocking would have failed for everyone.
 *
 * The fallback names index.html under `root`: Hono 4 reads a `path` given
 * alone against the working directory, so `path: <dist>/index.html` was
 * never found from apps/api, where the api runs, and a deep link loaded
 * on its own got a JSON 404 from the api.
 */
export function serveWebApp(app: Hono, webDist: string): void {
  // 1) Real files (assets/*.js, build-id.txt, favicon, /boot-guard.js, /boot.css)
  app.use('/*', serveStatic({ root: webDist }));
  app.get('/assets/*', (c) => c.notFound());
  // 2) SPA fallback: any other unmatched GET gets index.html.
  app.get('*', serveStatic({ root: webDist, path: 'index.html' }));
}
