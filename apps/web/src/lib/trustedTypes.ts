/**
 * Review MWD-13 (modern-web-guidance: trusted-types): the app's one
 * Trusted Types policy, the `default` policy, ready for when the CSP's
 * `require-trusted-types-for 'script'` is enforced (it is report-only
 * today, http/securityHeaders.ts on the api).
 *
 * The app writes no HTML and runs no strings as code, so the policy only
 * has `createScriptURL`. That covers the script-URL sinks a plain string
 * reaches: the service worker (`/sw.js`), Web Workers, and the face
 * tracker's wasm loader, which MediaPipe puts in a `<script src>` (or
 * `importScripts` inside a worker). A URL is passed through only when it
 * is on this origin and is the service worker or a built file under
 * `/assets/`. Anything else returns null, which the browser blocks and
 * reports. In dev (the Vite server) every same-origin URL passes, since
 * modules load from /src and /node_modules there.
 *
 * Works in a window and in a worker (`globalThis`), so the face worker
 * installs it too.
 */

/** The script URLs the policy lets through, as a pure rule for tests. */
export function allowedScriptUrl(input: string, origin: string, dev: boolean): string | null {
  let url: URL;
  try {
    url = new URL(input, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  if (dev) return url.href;
  if (url.pathname === '/sw.js' || url.pathname.startsWith('/assets/')) return url.href;
  return null;
}

interface TrustedTypePolicyFactoryLike {
  createPolicy(
    name: string,
    rules: { createScriptURL?: (input: string) => string | null },
  ): unknown;
  defaultPolicy?: unknown;
}

/**
 * Creates the `default` policy once. A no-op where Trusted Types are
 * unsupported (Safari before 26, Firefox before 148) or a default policy
 * already exists.
 */
export function installTrustedTypesPolicy(): void {
  const factory = (globalThis as { trustedTypes?: TrustedTypePolicyFactoryLike }).trustedTypes;
  if (!factory || factory.defaultPolicy) return;
  const origin = globalThis.location.origin;
  const dev = import.meta.env.DEV;
  try {
    factory.createPolicy('default', {
      createScriptURL: (input) => allowedScriptUrl(input, origin, dev),
    });
  } catch {
    /* the CSP refused the name: the reports show it, nothing breaks */
  }
}
