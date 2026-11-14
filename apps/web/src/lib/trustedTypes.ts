/**
 * Review MWD-13 (modern-web-guidance: trusted-types): the app's one
 * Trusted Types policy, the `default` policy, for the CSP's enforced
 * `require-trusted-types-for 'script'` (http/securityHeaders.ts on the api).
 *
 * The app writes no HTML and runs no strings as code. The policy has
 * `createScriptURL`, which covers the script-URL sinks a plain string
 * reaches: the service worker (`/sw.js`), Web Workers, and the face
 * tracker's wasm loader, which MediaPipe puts in a `<script src>` (or
 * `importScripts` inside a worker). A URL is passed through only when it
 * is on this origin and is the service worker or a built file under
 * `/assets/`. Anything else returns null, which the browser blocks and
 * reports. In dev (the Vite server) every same-origin URL passes, since
 * modules load from /src and /node_modules there.
 *
 * And `createHTML` for one constant (2026-11-15): Leaflet (the attendance
 * map) checks for SVG support at load with `div.innerHTML = '<svg/>'`,
 * which the enforced policy blocked, so the map never loaded. That exact
 * string passes; any other HTML string returns null and is blocked. The
 * map's own code passes elements, not HTML (components/geo/GeoMapView.tsx).
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

/** HTML strings a library writes that the policy lets through: constants only. */
const ALLOWED_HTML: ReadonlySet<string> = new Set([
  // Leaflet's SVG support check (leaflet/src/core/Browser.js).
  '<svg/>',
]);

/** The HTML strings the policy lets through, as a pure rule for tests. */
export function allowedHtml(input: string): string | null {
  return ALLOWED_HTML.has(input) ? input : null;
}

interface TrustedTypePolicyFactoryLike {
  createPolicy(
    name: string,
    rules: {
      createScriptURL?: (input: string) => string | null;
      createHTML?: (input: string) => string | null;
    },
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
      createHTML: allowedHtml,
    });
  } catch {
    /* the CSP refused the name: the reports show it, nothing breaks */
  }
}
