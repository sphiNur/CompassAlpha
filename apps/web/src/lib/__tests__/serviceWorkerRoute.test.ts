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

// R2-SHL-1 / R2-ENG-5 (2026-10-31): the first visit precaches the shell,
// and a page load the proxy answers 5xx (origin down) gets the cached shell.
type Listener = (event: Record<string, unknown>) => void;
function loadWorker(fetchImpl: (req: unknown) => Promise<Response>) {
  const src = readFileSync(join(import.meta.dir, '../../../public/sw.js'), 'utf8');
  const listeners: Record<string, Listener> = {};
  const stored = new Map<string, Response>();
  const cache = {
    put: async (k: unknown, res: Response) => void stored.set(typeof k === 'string' ? k : String((k as Request).url ?? k), res),
    add: async (u: string) => void stored.set(u, new Response('asset')),
    match: async (k: string) => stored.get(k),
    keys: async () => [],
    delete: async () => true,
  };
  const caches = {
    open: async () => cache,
    match: async (k: unknown) => stored.get(typeof k === 'string' ? k : String((k as { url?: string }).url)),
    keys: async () => [],
    delete: async () => true,
  };
  const fakeSelf: Record<string, unknown> = {
    addEventListener: (type: string, fn: Listener) => (listeners[type] = fn),
    skipWaiting: () => {},
    location: { origin: O },
  };
  new Function('self', 'caches', 'fetch', src)(fakeSelf, caches, fetchImpl);
  return { listeners, stored, self: fakeSelf };
}

describe('sw.js shell precache and origin-down fallback', () => {
  it('finds the entry files index.html names', () => {
    const { self } = loadWorker(async () => new Response(''));
    const urls = (self.__compassShellAssetUrls as (h: string) => string[])(
      '<link rel="stylesheet" href="/boot.css"><script src="/boot-guard.js"></script>' +
        '<script type="module" crossorigin src="/assets/index-abc.js"></script>' +
        '<link rel="modulepreload" href="/assets/vendor-x.js"><link href="/assets/index-y.css" rel="stylesheet">' +
        '<script src="https://telegram.org/js/telegram-web-app.js"></script>',
    );
    expect(urls).toEqual(['/boot.css', '/boot-guard.js', '/assets/index-abc.js', '/assets/vendor-x.js', '/assets/index-y.css']);
  });

  it('install caches index.html and its entry files', async () => {
    const html = '<script type="module" src="/assets/index-abc.js"></script>';
    const res = new Response(html, { status: 200 });
    Object.defineProperty(res, 'type', { value: 'basic' });
    const { listeners, stored } = loadWorker(async () => res);
    let done: Promise<unknown> = Promise.resolve();
    listeners.install!({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    expect([...stored.keys()].sort()).toEqual(['/assets/index-abc.js', '/index.html']);
  });

  it('a page load answered 502/503/504 gets the cached shell', async () => {
    for (const status of [502, 503, 504, 530]) {
      const { listeners, stored } = loadWorker(async () => new Response('Bad gateway', { status }));
      stored.set('/index.html', new Response('shell'));
      let answer: Promise<Response> | null = null;
      listeners.fetch!({
        request: { method: 'GET', url: O + '/', mode: 'navigate' },
        respondWith: (p: Promise<Response>) => (answer = p),
      });
      expect(await (await answer!).text()).toBe('shell');
    }
  });

  it('a 404 page is passed through, and with no cached shell a 502 is too', async () => {
    const notFound = loadWorker(async () => new Response('nf', { status: 404 }));
    notFound.stored.set('/index.html', new Response('shell'));
    let answer: Promise<Response> | null = null;
    notFound.listeners.fetch!({
      request: { method: 'GET', url: O + '/x', mode: 'navigate' },
      respondWith: (p: Promise<Response>) => (answer = p),
    });
    expect((await answer!).status).toBe(404);

    const empty = loadWorker(async () => new Response('bad', { status: 502 }));
    empty.listeners.fetch!({
      request: { method: 'GET', url: O + '/', mode: 'navigate' },
      respondWith: (p: Promise<Response>) => (answer = p),
    });
    expect((await answer!).status).toBe(502);
  });
});
