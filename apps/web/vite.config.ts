import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * Replaces `%VITE_BUILD_SHA%` in index.html with the env value at build
 * time. The runtime "new version available, tap reload" check reads
 * `<meta name="compass-build">` and compares it with /health/version.
 */
function buildShaPlugin(): Plugin {
  // One sha per build invocation so meta tag in index.html and
  // build-id.txt emitted alongside dist/ stay in sync. The API's
  // /health/version reads build-id.txt at request time, letting the
  // client detect "you're on an old bundle" and prompt a reload.
  const sha = process.env.VITE_BUILD_SHA || String(Date.now());
  return {
    name: 'compass:build-sha',
    transformIndexHtml(html) {
      return html.replace(/%VITE_BUILD_SHA%/g, sha);
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build-id.txt', source: sha });
    },
  };
}

export default defineConfig(({ mode }) => {
  /**
   * Build-time hard guard against shipping the dev auth bypass to
   * production (M3.18, launch hardening 2026-05-16).
   *
   * `VITE_DEV_MOCK_INIT_DATA` is a developer convenience that lets
   * the SPA boot with a fake Telegram initData blob (skipping the
   * real HMAC handshake). Vite inlines `import.meta.env.VITE_*` at
   * build time, so if this env var leaks into a production build
   * the bundle ships a hard-coded auth bypass — every user logs in
   * as the mock identity.
   *
   * Defense in depth:
   *   1. Here: refuse to build if the var is set in production mode.
   *   2. AuthGate.tsx: read it only when `import.meta.env.DEV` —
   *      Rollup tree-shakes the branch entirely in production.
   *   3. deploy.ts: grep the server's .env before each deploy.
   */
  if (mode === 'production') {
    // M3.25 (2026-05-18 incident #2): the original guard only read
    // `process.env.VITE_DEV_MOCK_INIT_DATA`. Vite's actual env loader
    // (which is what bakes values into the bundle) ALSO consults the
    // .env / .env.production / .env.local files via loadEnv, and
    // those values do NOT round-trip into process.env. So a dev's
    // apps/web/.env carrying the mock initData blob slipped past the
    // guard and shipped to production — twice in one day. Now we
    // call loadEnv ourselves with the same prefix Vite uses for
    // client values and refuse to build if it surfaces the bypass.
    const fileEnv = loadEnv(mode, process.cwd(), 'VITE_');
    const fromProcess = process.env.VITE_DEV_MOCK_INIT_DATA;
    const fromFile = fileEnv.VITE_DEV_MOCK_INIT_DATA;
    if (fromProcess || fromFile) {
      throw new Error(
        'BUILD ABORT: VITE_DEV_MOCK_INIT_DATA is set during a production build. ' +
          'This would bake a dev-only auth bypass into the bundle. ' +
          `Source: ${fromProcess ? 'process.env' : ''}${fromProcess && fromFile ? ' + ' : ''}${fromFile ? '.env file in ' + process.cwd() : ''}. ` +
          'Unset it before running `pnpm build`.',
      );
    }
  }
  return {
    /**
     * Asset base URL.
     *
     * - 'production' / 'development' → '/' — assets at root of the
     *   serving origin. Production is served by Hono's serveStatic
     *   under https://<domain>/, dev is served by vite on port 5173.
     * - 'preview' (new in M3.18) → './' — relative paths so the built
     *   dist/index.html can be opened DIRECTLY as a static file
     *   without a webserver. Useful for Claude Desktop's Launch panel
     *   which blocks cross-protocol redirects from file:// to
     *   http://localhost. Build with:
     *       pnpm --filter @compass/web exec vite build --mode preview
     *   then open apps/web/dist/index.html in the Launch panel.
     */
    base: mode === 'preview' ? './' : '/',
    plugins: [react(), buildShaPlugin()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      port: 5173,
      host: true,
    },
    build: {
      // es2020 covers iOS 14+ (Telegram WebView lags actual Safari).
      target: 'es2020',
      /**
       * M1.20 (2026-05-08, launch hardening): NEVER ship sourcemaps to
       * production. Before this flag, `pnpm build` emitted `*.js.map`
       * files alongside the bundle — anyone with devtools could read
       * the full original TypeScript, including auth flows, business
       * logic, and any inline strings (API URL patterns, error keys).
       * That's a security + IP leak.
       *
       * For dev / staging where you want decoded stack traces, set
       * `VITE_SOURCEMAP=true` in the env before building. The
       * `Date.now()` build SHA fallback already lets us match a
       * server-side trace to a bundle without source maps.
       */
      sourcemap: process.env.VITE_SOURCEMAP === 'true',
      // No `manualChunks` — earlier split caused a circular reference
      // between tanstack/react-query and @trpc/react-query (which
      // depends on it), producing undefined module exports on iOS
      // Telegram WebView and a silent black screen with no JS error
      // before React even mounted. Rollup's automatic splitting is fine.
    },
  };
});
