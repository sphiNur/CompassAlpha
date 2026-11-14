import { describe, expect, test } from 'bun:test';
// Review MWD-12 / MWD-13 / MWD-18: nginx serves the page and its scripts
// without the api, so the Worker adds the api's security headers to them.
// The strings must be the api's own.
import { Hono } from 'hono';
import { securityHeaders } from '../http/securityHeaders';

// The Worker is plain JS deployed with wrangler, outside the api's types.
const WORKER: string = '../../../../infra/cloudflare/app-proxy/worker.js';
const { pageSecurityHeaders, withPageSecurity } = (await import(WORKER)) as {
  pageSecurityHeaders(host: string): Record<string, string>;
  withPageSecurity(response: Response, host: string): Response;
};

describe('page security headers (review MWD-18)', () => {
  const HOST = 'compass-alpha.sphinxr.workers.dev';

  test('are the headers the api sends on a page', async () => {
    const app = new Hono();
    app.use('*', securityHeaders({ production: true, connectOrigins: [] }));
    app.get('/', (c) => c.html('<!doctype html>'));
    const res = await app.request('/', { headers: { 'x-forwarded-host': HOST } });
    const ours = pageSecurityHeaders(HOST);
    for (const [name, value] of Object.entries(ours)) {
      expect(`${name}: ${res.headers.get(name)}`).toBe(`${name}: ${value}`);
    }
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups');
  });

  test('are added to a page or script without a CSP, and nothing else', async () => {
    const page = withPageSecurity(
      new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }),
      HOST,
    );
    expect(page.headers.get('content-security-policy-report-only')).toContain(
      "require-trusted-types-for 'script'",
    );
    expect(page.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups');

    const script = withPageSecurity(
      new Response('', { headers: { 'content-type': 'application/javascript' } }),
      HOST,
    );
    expect(script.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(script.headers.get('cross-origin-opener-policy')).toBeNull();

    const wasm = withPageSecurity(
      new Response('', { headers: { 'content-type': 'application/wasm' } }),
      HOST,
    );
    expect(wasm.headers.get('content-security-policy')).toBeNull();

    const api = withPageSecurity(
      new Response('', {
        headers: { 'content-type': 'text/html', 'content-security-policy': "default-src 'none'" },
      }),
      HOST,
    );
    expect(api.headers.get('content-security-policy')).toBe("default-src 'none'");
  });

  test('a bad Host gives no wss source', () => {
    expect(pageSecurityHeaders('evil host;')['content-security-policy-report-only']).toContain(
      "connect-src 'self' https://telegram.org;",
    );
  });
});
