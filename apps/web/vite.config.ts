import { defineConfig, type Plugin } from 'vite';
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

export default defineConfig({
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
    sourcemap: true,
    // No `manualChunks` — earlier split caused a circular reference
    // between tanstack/react-query and @trpc/react-query (which
    // depends on it), producing undefined module exports on iOS
    // Telegram WebView and a silent black screen with no JS error
    // before React even mounted. Rollup's automatic splitting is fine.
  },
});
