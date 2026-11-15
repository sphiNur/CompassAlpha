import { describe, expect, test } from 'bun:test';
// Review MWD-12 / MWD-13 / MWD-18: nginx serves the page and its scripts
// without the api, so the Worker adds the api's security headers to them.
// The strings must be the api's own.
import { Hono } from 'hono';
import { securityHeaders } from '../http/securityHeaders';

// The Worker is plain JS deployed with wrangler, outside the api's types.
const WORKER: string = '../../../../infra/cloudflare/app-proxy/worker.js';
const { connectOrigins, pageSecurityHeaders, withPageSecurity } = (await import(WORKER)) as {
  connectOrigins(value: string | undefined): string[];
  pageSecurityHeaders(host: string, extraConnect?: readonly string[]): Record<string, string>;
  withPageSecurity(response: Response, host: string, extraConnect?: readonly string[]): Response;
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

  // MWG review (2026-11-15): COMPASS_CONNECT_ORIGINS is the Worker's copy
  // of the api's bucket origin.
  test("with the bucket origin they are still the api's", async () => {
    const BUCKET = 'https://photos.s3.example.com';
    const app = new Hono();
    app.use('*', securityHeaders({ production: true, connectOrigins: [BUCKET] }));
    app.get('/', (c) => c.html('<!doctype html>'));
    const res = await app.request('/', { headers: { 'x-forwarded-host': HOST } });
    const ours = pageSecurityHeaders(HOST, connectOrigins(BUCKET));
    expect(ours['content-security-policy']).toContain(
      `wss://${HOST} ${BUCKET} https://telegram.org`,
    );
    for (const [name, value] of Object.entries(ours)) {
      expect(`${name}: ${res.headers.get(name)}`).toBe(`${name}: ${value}`);
    }
    // The page's CORP, as the api's.
    const page = withPageSecurity(
      new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }),
      HOST,
      [BUCKET],
    );
    expect(page.headers.get('cross-origin-resource-policy')).toBe(
      res.headers.get('cross-origin-resource-policy'),
    );
    expect(page.headers.get('content-security-policy')).toContain(BUCKET);
  });

  test('COMPASS_CONNECT_ORIGINS takes bare https origins only; unset changes nothing', () => {
    expect(connectOrigins(undefined)).toEqual([]);
    expect(connectOrigins('')).toEqual([]);
    expect(
      connectOrigins(
        '  https://a.example   https://b.example:8443\nhttps://a.example http://c.example ' +
          'https://d.example/path https://e.example/ https://u:p@f.example not-a-url ' +
          "https://g.example;script-src https://h.example'",
      ),
    ).toEqual(['https://a.example', 'https://b.example:8443']);
    expect(pageSecurityHeaders(HOST, connectOrigins(undefined))).toEqual(pageSecurityHeaders(HOST));
  });

  test('are added to a page or script without a CSP, and nothing else', async () => {
    const page = withPageSecurity(
      new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }),
      HOST,
    );
    expect(page.headers.get('content-security-policy')).toContain(
      "require-trusted-types-for 'script'",
    );
    expect(page.headers.get('content-security-policy-report-only')).toBeNull();
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
    expect(pageSecurityHeaders('evil host;')['content-security-policy']).toContain(
      "connect-src 'self' https://telegram.org;",
    );
  });
});
