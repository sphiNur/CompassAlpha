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
const SDK = 'https://telegram.org/js/telegram-web-app.js';
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
    expect(route({ method: 'GET', url: 'https://telegram.org/js/other.js' }, O)).toBeNull();
  });

  // COREWEB1-14 (2026-11-11): an offline start without it ran as in a
  // plain browser.
  it('keeps the Telegram SDK, the one script from another origin', () => {
    expect(route({ method: 'GET', url: SDK, mode: 'no-cors' }, O)).toBe('sdk');
    expect(route({ method: 'POST', url: SDK }, O)).toBeNull();
  });
});

/** A same-origin answer, typed as the browser types it (`new Response` is 'default'). */
function basic(body: string, contentType: string, status = 200): Response {
  const res = new Response(body, { status, headers: { 'content-type': contentType } });
  Object.defineProperty(res, 'type', { value: 'basic' });
  return res;
}

/** The answer to a no-cors request for another origin's file: status 0, unreadable. */
function opaque(body = 'sdk'): Response {
  const res = new Response(body);
  Object.defineProperties(res, {
    type: { value: 'opaque' },
    status: { value: 0 },
    ok: { value: false },
  });
  return res;
}

/** A fetch event: what the worker answers, and what it asked the browser to wait for. */
function fetchEvent(request: { method: string; url: string; mode?: string }) {
  const event = {
    request,
    answer: undefined as Promise<Response> | undefined,
    done: undefined as Promise<unknown> | undefined,
    respondWith(p: Promise<Response>) {
      event.answer = p;
    },
    waitUntil(p: Promise<unknown>) {
      event.done = p;
    },
  };
  return event;
}

// R2-SHL-1 / R2-ENG-5 (2026-10-31): the first visit precaches the shell,
// and a page load the proxy answers 5xx (origin down) gets the cached shell.
type Listener = (event: Record<string, unknown>) => void;
type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
};
function loadWorker(
  fetchImpl: (req: unknown, init?: RequestInit) => Promise<Response>,
  { timers = { setTimeout, clearTimeout } as Timers, slowPut = false } = {},
) {
  const src = readFileSync(join(import.meta.dir, '../../../public/sw.js'), 'utf8');
  const listeners: Record<string, Listener> = {};
  const stored = new Map<string, Response>();
  const cache = {
    put: async (k: unknown, res: Response) => {
      if (slowPut) await new Promise((r) => setTimeout(r, 5));
      stored.set(typeof k === 'string' ? k : String((k as Request).url ?? k), res);
    },
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
  new Function('self', 'caches', 'fetch', 'setTimeout', 'clearTimeout', src)(
    fakeSelf,
    caches,
    fetchImpl,
    timers.setTimeout,
    timers.clearTimeout,
  );
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

  it('install caches index.html, its entry files and the Telegram SDK', async () => {
    const html = '<script type="module" src="/assets/index-abc.js"></script>';
    const asked: Array<[unknown, RequestInit | undefined]> = [];
    const { listeners, stored } = loadWorker(async (req, init) => {
      asked.push([req, init]);
      if (req === '/') return basic(html, 'text/html; charset=utf-8');
      if (req === SDK) return opaque();
      return basic('js', 'text/javascript');
    });
    let done: Promise<unknown> = Promise.resolve();
    listeners.install!({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    expect([...stored.keys()].sort()).toEqual(['/assets/index-abc.js', '/index.html', SDK]);
    // As index.html asks for it (no `crossorigin`), and as a background
    // copy at low priority (review MWD-03), as are the entry files.
    expect(asked.find(([req]) => req === SDK)![1]).toEqual({ mode: 'no-cors', priority: 'low' });
    expect(asked.find(([req]) => req === '/assets/index-abc.js')![1]).toEqual({ priority: 'low' });
  });

  it('a page load answered 502/503/504 gets the cached shell', async () => {
    for (const status of [502, 503, 504, 530]) {
      const { listeners, stored } = loadWorker(async () => new Response('Bad gateway', { status }));
      stored.set('/index.html', new Response('shell'));
      const event = fetchEvent({ method: 'GET', url: O + '/', mode: 'navigate' });
      listeners.fetch!(event);
      expect(await (await event.answer!).text()).toBe('shell');
    }
  });

  it('a 404 page is passed through, and with no cached shell a 502 is too', async () => {
    const notFound = loadWorker(async () => new Response('nf', { status: 404 }));
    notFound.stored.set('/index.html', new Response('shell'));
    const missing = fetchEvent({ method: 'GET', url: O + '/x', mode: 'navigate' });
    notFound.listeners.fetch!(missing);
    expect((await missing.answer!).status).toBe(404);

    const empty = loadWorker(async () => new Response('bad', { status: 502 }));
    const down = fetchEvent({ method: 'GET', url: O + '/', mode: 'navigate' });
    empty.listeners.fetch!(down);
    expect((await down.answer!).status).toBe(502);
  });
});

// COREWEB1-15 (2026-11-11): what is kept must be what it claims to be, the
// write is part of the fetch event, and a page load that gets no answer
// falls back to the cached shell instead of waiting for the browser.
describe('sw.js cache writes (COREWEB1-15)', () => {
  const cacheable = loadWorker(async () => new Response('')).self.__compassSwCacheable as (
    res: Response,
    kind: string,
  ) => boolean;
  const page = '<!doctype html><title>Compass</title>';

  it('keeps a page only as HTML, and a file never as HTML', () => {
    expect(cacheable(basic(page, 'text/html; charset=utf-8'), 'page')).toBe(true);
    expect(cacheable(basic('body{}', 'text/css'), 'page')).toBe(false);
    // index.html with 200 is what the server answers for a path it does
    // not know, e.g. a stray .png or an old deploy's file.
    for (const kind of ['asset', 'static']) {
      expect(cacheable(basic(page, 'text/html; charset=utf-8'), kind)).toBe(false);
      expect(cacheable(basic('x', 'text/javascript'), kind)).toBe(true);
      expect(cacheable(basic('nf', 'text/plain', 404), kind)).toBe(false);
    }
  });

  it('keeps the SDK’s opaque answer, and nothing opaque from the app’s own origin', () => {
    expect(cacheable(opaque(), 'sdk')).toBe(true);
    expect(cacheable(opaque(), 'static')).toBe(false);
  });

  it('a file answered with the page is passed on but not kept', async () => {
    const { listeners, stored } = loadWorker(async () => basic(page, 'text/html'));
    const event = fetchEvent({ method: 'GET', url: O + '/assets/gone-1.js', mode: 'cors' });
    listeners.fetch!(event);
    expect(await (await event.answer!).text()).toBe(page);
    await event.done;
    expect(stored.size).toBe(0);
  });

  it('the fresh shell is stored before the event ends', async () => {
    const { listeners, stored } = loadWorker(async () => basic(page, 'text/html'), {
      slowPut: true,
    });
    const event = fetchEvent({ method: 'GET', url: O + '/order', mode: 'navigate' });
    listeners.fetch!(event);
    await event.answer;
    expect(stored.has('/index.html')).toBe(false); // still being written
    await event.done;
    expect(await stored.get('/index.html')!.text()).toBe(page);
  });

  it('a page load with no answer after 4 s gets the cached shell; the late answer is still kept', async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    let arrive: (res: Response) => void = () => {};
    const { listeners, stored } = loadWorker(
      () => new Promise<Response>((resolve) => (arrive = resolve)),
      { timers: { setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout: () => {} } },
    );
    stored.set('/index.html', new Response('old shell'));
    const event = fetchEvent({ method: 'GET', url: O + '/', mode: 'navigate' });
    listeners.fetch!(event);
    expect(timers.map((t) => t.ms)).toEqual([4000]);
    timers[0]!.fn();
    expect(await (await event.answer!).text()).toBe('old shell');
    arrive(basic(page, 'text/html'));
    await event.done;
    expect(await stored.get('/index.html')!.text()).toBe(page);
  });

  it('with no cached shell the page load waits for the network', async () => {
    const timers: Array<() => void> = [];
    let arrive: (res: Response) => void = () => {};
    const { listeners } = loadWorker(() => new Promise<Response>((resolve) => (arrive = resolve)), {
      timers: { setTimeout: (fn) => timers.push(fn), clearTimeout: () => {} },
    });
    const event = fetchEvent({ method: 'GET', url: O + '/', mode: 'navigate' });
    listeners.fetch!(event);
    timers[0]!();
    arrive(basic(page, 'text/html'));
    expect(await (await event.answer!).text()).toBe(page);
  });
});

describe('sw.js Telegram SDK (COREWEB1-14)', () => {
  const request = { method: 'GET', url: SDK, mode: 'no-cors' };

  it('online: telegram.org’s answer, kept for next time', async () => {
    const { listeners, stored } = loadWorker(async () => opaque('fresh sdk'));
    const event = fetchEvent(request);
    listeners.fetch!(event);
    expect((await event.answer!).type).toBe('opaque');
    await event.done;
    expect(await stored.get(SDK)!.text()).toBe('fresh sdk');
  });

  it('offline: the kept copy', async () => {
    const { listeners, stored } = loadWorker(async () => {
      throw new TypeError('Failed to fetch');
    });
    stored.set(SDK, new Response('kept sdk'));
    const event = fetchEvent(request);
    listeners.fetch!(event);
    expect(await (await event.answer!).text()).toBe('kept sdk');
  });

  it('offline with no kept copy: the load fails as it would without the worker', async () => {
    const { listeners } = loadWorker(async () => {
      throw new TypeError('Failed to fetch');
    });
    const event = fetchEvent(request);
    listeners.fetch!(event);
    await expect(event.answer!).rejects.toThrow('Failed to fetch');
  });
});

// COREWEB1-06 (2026-11-09): the asset cache keeps what is in use. The
// fake keeps entries in the order the Cache API does: a put of a URL
// already stored removes it and appends the new one.
function orderedCache() {
  const entries: Array<{ url: string; body: string }> = [];
  const href = (k: unknown) =>
    new URL(typeof k === 'string' ? k : (k as { url: string }).url, O).href;
  const at = (k: unknown) => entries.findIndex((e) => e.url === href(k));
  let puts = 0;
  const cache = {
    entries,
    puts: () => puts,
    keys: async () => entries.map((e) => ({ url: e.url })),
    match: async (k: unknown) => {
      const e = entries[at(k)];
      return e ? new Response(e.body) : undefined;
    },
    put: async (k: unknown, res: Response) => {
      puts++;
      const body = await res.text();
      const i = at(k);
      if (i >= 0) entries.splice(i, 1);
      entries.push({ url: href(k), body });
    },
    add: async (u: string) => cache.put(u, new Response('fetched')),
    delete: async (k: unknown) => {
      const i = at(k);
      if (i >= 0) entries.splice(i, 1);
      return i >= 0;
    },
  };
  return cache;
}

function loadWorkerWith(cache: ReturnType<typeof orderedCache>) {
  const src = readFileSync(join(import.meta.dir, '../../../public/sw.js'), 'utf8');
  const listeners: Record<string, Listener> = {};
  const caches = { open: async () => cache, match: cache.match, keys: async () => [] };
  const fakeSelf: Record<string, unknown> = {
    addEventListener: (type: string, fn: Listener) => (listeners[type] = fn),
    location: { origin: O },
  };
  const fetchImpl = async () => {
    const res = new Response('network');
    Object.defineProperty(res, 'type', { value: 'basic' });
    return res;
  };
  new Function('self', 'caches', 'fetch', src)(fakeSelf, caches, fetchImpl);
  return {
    listeners,
    trim: fakeSelf.__compassTrimAssets as (c: unknown, keep?: string[]) => Promise<unknown>,
  };
}

const paths = (cache: ReturnType<typeof orderedCache>) =>
  cache.entries.map((e) => new URL(e.url).pathname);

describe('sw.js asset cache trimming (COREWEB1-06)', () => {
  it("drops the oldest beyond 300, never the shell's own files or the ones just reported", async () => {
    const cache = orderedCache();
    await cache.put(
      '/index.html',
      new Response(
        '<script type="module" src="/assets/a0.js"></script><link rel="modulepreload" href="/assets/a1.js">',
      ),
    );
    for (let i = 0; i < 305; i++) await cache.put(`/assets/a${i}.js`, new Response(''));
    const { trim } = loadWorkerWith(cache);
    await trim(cache, [`${O}/assets/a2.js`]);
    const left = paths(cache);
    expect(left.filter((p) => p.startsWith('/assets/')).length).toBe(300);
    for (const kept of ['/assets/a0.js', '/assets/a1.js', '/assets/a2.js', '/index.html']) {
      expect(left).toContain(kept);
    }
    for (const gone of ['/assets/a3.js', '/assets/a7.js']) expect(left).not.toContain(gone);
    expect(left).toContain('/assets/a8.js');
  });

  it('leaves a cache within the limit alone', async () => {
    const cache = orderedCache();
    for (let i = 0; i < 10; i++) await cache.put(`/assets/b${i}.js`, new Response(''));
    const { trim } = loadWorkerWith(cache);
    await trim(cache);
    expect(cache.entries.length).toBe(10);
  });

  it('a cache hit is written again once per worker, so it counts as recently used', async () => {
    const cache = orderedCache();
    await cache.put('/assets/old.js', new Response('old'));
    await cache.put('/assets/new.js', new Response('new'));
    const { listeners } = loadWorkerWith(cache);
    const hit = async () => {
      const event = fetchEvent({ method: 'GET', url: `${O}/assets/old.js`, mode: 'cors' });
      listeners.fetch!(event);
      expect(await (await event.answer!).text()).toBe('old');
      await event.done;
    };
    const before = cache.puts();
    await hit();
    expect(paths(cache)).toEqual(['/assets/new.js', '/assets/old.js']);
    await hit();
    expect(cache.puts()).toBe(before + 1);
    // Stored under its URL alone, as before: one entry, not two.
    expect(cache.entries.length).toBe(2);
  });

  it('the files a page reports are marked as used, and the cache is trimmed after', async () => {
    const cache = orderedCache();
    for (let i = 0; i < 301; i++) await cache.put(`/assets/c${i}.js`, new Response(''));
    const { listeners } = loadWorkerWith(cache);
    let done: Promise<unknown> = Promise.resolve();
    listeners.message!({
      data: { type: 'compass:cache-urls', urls: [`${O}/assets/c0.js`] },
      waitUntil: (p: Promise<unknown>) => (done = p),
    });
    await done;
    const left = paths(cache);
    expect(left.length).toBe(300);
    expect(left).toContain('/assets/c0.js');
    expect(left).not.toContain('/assets/c1.js');
    expect(left.at(-1)).toBe('/assets/c0.js');
  });
});
