/**
 * Reviews MWD-16, MWD-17 and MWD-19 (modern-web-guidance: security,
 * validate-origins): the headers every response carries, and the origins
 * CORS lets in.
 */
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { allowedCorsOrigin, securityHeaders } from '../http/securityHeaders';

function app(production: boolean) {
  const a = new Hono();
  a.use('*', securityHeaders({ production }));
  a.get('/', (c) => c.html('<!doctype html><title>Compass</title>'));
  a.get('/json', (c) => c.json({ ok: true }));
  a.get('/boom', () => {
    throw new Error('boom');
  });
  a.onError((_err, c) => c.json({ error: 'internal' }, 500));
  return a;
}

describe('security headers', () => {
  test('Telegram may frame the app: frame-ancestors, and no X-Frame-Options (MWD-16)', async () => {
    for (const path of ['/', '/json', '/boom']) {
      const res = await app(true).request(path);
      expect(res.headers.get('x-frame-options')).toBeNull();
      expect(res.headers.get('content-security-policy')).toContain(
        "frame-ancestors 'self' https://web.telegram.org https://t.me",
      );
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  test('the page has COOP same-origin-allow-popups; the JSON does not need it (MWD-19)', async () => {
    const page = await app(true).request('/');
    expect(page.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups');
    const json = await app(true).request('/json');
    expect(json.headers.get('cross-origin-opener-policy')).toBeNull();
  });

  test('HSTS in production only', async () => {
    expect((await app(true).request('/json')).headers.get('strict-transport-security')).toContain(
      'max-age=31536000',
    );
    expect((await app(false).request('/json')).headers.get('strict-transport-security')).toBeNull();
  });
});

describe('allowedCorsOrigin (MWD-17)', () => {
  const prod = { frontendUrl: 'https://compass.example', production: true };
  const dev = { frontendUrl: 'http://localhost:5173', production: false };

  test('the app itself and Telegram over https', () => {
    for (const origin of [
      'https://compass.example',
      'https://web.telegram.org',
      'https://webk.telegram.org',
      'https://t.me',
    ]) {
      expect(allowedCorsOrigin(origin, prod)).toBe(origin);
    }
  });

  test('not over http, not a look-alike, not a malformed origin', () => {
    for (const origin of [
      'http://web.telegram.org',
      'http://t.me',
      'https://eviltelegram.org',
      'https://telegram.org.evil.example',
      'https://web.telegram.org.evil.example',
      'https://x.t.me',
      'https://evil.example/.telegram.org',
      'https://user@web.telegram.org',
      'null',
      'web.telegram.org',
      '',
    ]) {
      expect(allowedCorsOrigin(origin, prod)).toBeNull();
    }
  });

  test('tunnels and localhost in development only, by hostname', () => {
    const tunnel = 'https://abc.trycloudflare.com';
    expect(allowedCorsOrigin(tunnel, dev)).toBe(tunnel);
    expect(allowedCorsOrigin(tunnel, prod)).toBeNull();
    expect(allowedCorsOrigin('http://localhost:3000', dev)).toBe('http://localhost:3000');
    expect(allowedCorsOrigin('http://127.0.0.1:5173', dev)).toBe('http://127.0.0.1:5173');
    expect(allowedCorsOrigin('http://localhost:3000', prod)).toBeNull();
    // The old prefix match let these through in development.
    expect(allowedCorsOrigin('http://localhost.evil.example', dev)).toBeNull();
    expect(allowedCorsOrigin('http://127.0.0.1.evil.example', dev)).toBeNull();
  });
});
