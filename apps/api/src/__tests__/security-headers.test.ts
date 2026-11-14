/**
 * Reviews MWD-16, MWD-17 and MWD-19 (modern-web-guidance: security,
 * validate-origins): the headers every response carries, and the origins
 * CORS lets in.
 */
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { allowedCorsOrigin, reportOnlyCsp, securityHeaders } from '../http/securityHeaders';

function app(production: boolean, connectOrigins: string[] = []) {
  const a = new Hono();
  a.use('*', securityHeaders({ production, connectOrigins }));
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

describe('the report-only policy (MWD-12, MWD-13)', () => {
  const directives = (policy: string | null) =>
    new Map(
      (policy ?? '').split('; ').map((d) => {
        const [name, ...rest] = d.split(' ');
        return [name!, rest.join(' ')] as const;
      }),
    );

  test('sent beside the enforced policy, which is unchanged', async () => {
    const res = await app(true, ['https://bucket.s3.amazonaws.com']).request('/', {
      headers: { host: 'compass.example' },
    });
    const enforced = directives(res.headers.get('content-security-policy'));
    expect(enforced.get('connect-src')).toBe("'self' wss: https:");
    expect(enforced.get('script-src')).toBe("'self' 'wasm-unsafe-eval' https://telegram.org");
    expect(enforced.has('require-trusted-types-for')).toBe(false);
    expect(enforced.has('report-to')).toBe(false);

    const ro = directives(res.headers.get('content-security-policy-report-only'));
    expect(ro.get('connect-src')).toBe(
      "'self' wss://compass.example https://bucket.s3.amazonaws.com https://telegram.org",
    );
    expect(ro.get('require-trusted-types-for')).toBe("'script'");
    expect(ro.get('trusted-types')).toBe('default goog#html');
    expect(ro.get('script-src')).toContain("'report-sample'");
    expect(ro.get('frame-ancestors')).toBe(enforced.get('frame-ancestors'));
    expect(ro.get('report-uri')).toBe('/csp-report');
    expect(ro.get('report-to')).toBe('csp');
    expect(res.headers.get('reporting-endpoints')).toBe('csp="/csp-report"');
  });

  test('the forwarded public host is used; a strange Host is left out', async () => {
    const fwd = await app(true).request('/json', {
      headers: { host: 'origin.internal:8080', 'x-forwarded-host': 'compass.example' },
    });
    expect(fwd.headers.get('content-security-policy-report-only')).toContain(
      "connect-src 'self' wss://compass.example https://telegram.org;",
    );
    expect(reportOnlyCsp({ connectOrigins: [], host: null })).toContain(
      "connect-src 'self' https://telegram.org;",
    );
    const odd = await app(true).request('/json', {
      headers: { host: 'evil.example; script-src *' },
    });
    expect(odd.headers.get('content-security-policy-report-only')).toContain(
      "connect-src 'self' https://telegram.org;",
    );
  });

  test('on error responses too', async () => {
    const res = await app(true).request('/boom');
    expect(res.status).toBe(500);
    expect(res.headers.get('content-security-policy-report-only')).toContain('report-uri');
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
