import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// N12 (2026-10-30): public/sw.js keeps the app shell for an offline
// reload. It must never stand between the app and its data: only the
// shell and Vite's hashed assets may be served from its cache.
type Route = (req: { method: string; url: string; mode?: string }, origin: string) => string | null;

function loadRoute(): Route {
  const src = readFileSync(join(import.meta.dir, '../../../public/sw.js'), 'utf8');
  const fakeSelf: Record<string, unknown> = { addEventListener: () => {} };
  new Function('self', src)(fakeSelf);
  return fakeSelf.__compassSwRoute as Route;
}

const route = loadRoute();
const O = 'https://app.example';
const get = (path: string, mode = 'cors') => ({ method: 'GET', url: O + path, mode });

describe('sw.js route', () => {
  it('serves page loads network-first with the cached shell as fallback', () => {
    expect(route(get('/', 'navigate'), O)).toBe('page');
    expect(route(get('/?devAs=x', 'navigate'), O)).toBe('page');
  });

  it("caches Vite's hashed assets and the boot files", () => {
    expect(route(get('/assets/index-abc123.js'), O)).toBe('asset');
    expect(route(get('/boot.css'), O)).toBe('static');
    expect(route(get('/boot-guard.js'), O)).toBe('static');
  });

  it('never touches API calls, health checks, websockets or uploads', () => {
    for (const p of ['/trpc/run.get?input=1', '/health/version', '/ws', '/upload/x.jpg', '/sw.js']) {
      expect(route(get(p), O)).toBeNull();
      expect(route(get(p, 'navigate'), O)).toBeNull();
    }
  });

  it('never touches writes or other origins', () => {
    expect(route({ method: 'POST', url: O + '/trpc/run.create' }, O)).toBeNull();
    expect(route(get('/x.js'), 'https://other.example')).toBeNull();
    expect(route({ method: 'GET', url: 'https://telegram.org/js/telegram-web-app.js' }, O)).toBeNull();
  });
});
