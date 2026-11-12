/**
 * The app-proxy Worker (infra/cloudflare/app-proxy/worker.js), security
 * scan 2026-10-31:
 *   F4 — the upstream URL is the origin plus the client's path and query;
 *        a path like `//attacker.example/x` or `/\attacker.example` must
 *        never move the request to another host.
 *   F3 — among signed ntfy messages the largest signed timestamp wins,
 *        not the last one posted; the highest accepted timestamp is kept
 *        in KV and anything older (or older than the age window) is
 *        rejected.
 *   OPS-15 — the manual /__origin takes the same signed message, checked
 *        the same way; no shared key.
 *
 * fetch is stubbed; nothing touches ntfy, Cloudflare or a tunnel.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import worker, {
  pickOrigin,
  proxyTarget,
  resetStateForTests,
} from '../../infra/cloudflare/app-proxy/worker.js';

const KEY = 'test-signing-key';
const PUBLIC = 'https://compass-alpha.sphinxr.workers.dev';
const OLD = 'https://old-dead-tunnel.trycloudflare.com/';
const NEW = 'https://new-live-tunnel.trycloudflare.com/';
const now = () => Math.floor(Date.now() / 1000);

function signed(url: string, ts: number, key = KEY) {
  const sig = createHmac('sha256', key).update(`${url}|${ts}`).digest('hex');
  return `${url}|${ts}|${sig}`;
}
function ndjson(...messages: string[]) {
  return messages.map((message) => JSON.stringify({ event: 'message', message })).join('\n');
}

function memoryKv(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async get(k: string) {
      return data.get(k) ?? null;
    },
    async put(k: string, v: string) {
      data.set(k, v);
    },
  };
}

type Call = { url: string; init?: RequestInit };
const realFetch = globalThis.fetch;
let calls: Call[] = [];
let topic = '';
let upstream: (url: string) => Response = () => new Response('upstream ok');

beforeEach(() => {
  resetStateForTests();
  calls = [];
  topic = '';
  upstream = () => new Response('upstream ok');
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://ntfy.sh/')) return new Response(topic);
    calls.push({ url, init });
    return upstream(url);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function env(extra: Record<string, unknown> = {}) {
  return {
    ORIGIN_URL: 'https://fallback-env.trycloudflare.com',
    COMPASS_ORIGIN: memoryKv(),
    CLIENT_IP_PROXY_KEY: 'proxy-key',
    ...extra,
  };
}

describe('F4: proxy target stays on the origin host', () => {
  const origin = new URL(NEW);
  const target = (path: string) => proxyTarget(new URL(PUBLIC + path), origin);

  test('normal path and query are kept', () => {
    expect(target('/trpc/x?y=1')?.toString()).toBe(`${NEW}trpc/x?y=1`);
  });

  for (const path of [
    '//attacker.example/x',
    '/\\attacker.example',
    '/%2F%2Fattacker',
    '//attacker.example:443/x?q=1',
  ]) {
    test(`${path} keeps the origin host`, () => {
      const t = target(path);
      expect(t).not.toBeNull();
      expect(t!.host).toBe(origin.host);
      expect(t!.protocol).toBe('https:');
    });
  }

  test('the old relative-URL resolution really did move the host', () => {
    // Guards the test itself: the bug exists for these inputs.
    const incoming = new URL(`${PUBLIC}//attacker.example/x`);
    expect(new URL(incoming.pathname + incoming.search, origin).host).toBe('attacker.example');
    const backslash = new URL(`${PUBLIC}/\\attacker.example`);
    expect(new URL(backslash.pathname, origin).host).toBe('attacker.example');
  });

  test('end to end: //attacker.example/x is fetched from the origin with the proxy key', async () => {
    const e = env({ ORIGIN_URL: NEW });
    const res = await worker.fetch(new Request(`${PUBLIC}//attacker.example/x`), e);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const sent = new URL(calls[0]!.url);
    expect(sent.host).toBe('new-live-tunnel.trycloudflare.com');
    expect(sent.pathname).toBe('//attacker.example/x');
    expect(new Headers(calls[0]!.init?.headers).get('x-compass-proxy-key')).toBe('proxy-key');
  });

  test('end to end: normal request keeps method, path, query and headers', async () => {
    const e = env({ ORIGIN_URL: NEW });
    const res = await worker.fetch(
      new Request(`${PUBLIC}/trpc/x?y=1`, {
        method: 'POST',
        body: '{}',
        headers: { 'cf-connecting-ip': '203.0.113.9', 'x-compass-proxy-key': 'forged' },
      }),
      e,
    );
    expect(await res.text()).toBe('upstream ok');
    expect(calls[0]!.url).toBe(`${NEW}trpc/x?y=1`);
    expect(calls[0]!.init?.method).toBe('POST');
    const h = new Headers(calls[0]!.init?.headers);
    expect(h.get('host')).toBe('new-live-tunnel.trycloudflare.com');
    expect(h.get('x-forwarded-host')).toBe('compass-alpha.sphinxr.workers.dev');
    expect(h.get('x-compass-client-ip')).toBe('203.0.113.9');
    expect(h.get('x-compass-proxy-key')).toBe('proxy-key');
  });

  test('end to end: /ws upgrade is forwarded and a 101 is handed back untouched', async () => {
    const e = env({ ORIGIN_URL: NEW });
    // `new Response` refuses status 101, so fake the upstream object.
    const upgraded = { status: 101, headers: new Headers(), webSocket: {} } as unknown as Response;
    upstream = () => upgraded;
    const res = await worker.fetch(
      new Request(`${PUBLIC}/ws?token=t`, {
        headers: { upgrade: 'websocket', connection: 'Upgrade' },
      }),
      e,
    );
    expect(res).toBe(upgraded);
    expect(calls[0]!.url).toBe(`${NEW}ws?token=t`);
    expect(new Headers(calls[0]!.init?.headers).get('upgrade')).toBe('websocket');
  });

  test('redirects to the origin are rewritten to the public host', async () => {
    const e = env({ ORIGIN_URL: NEW });
    upstream = () => new Response(null, { status: 301, headers: { location: `${NEW}health/` } });
    const res = await worker.fetch(new Request(`${PUBLIC}/health`), e);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(`${PUBLIC}/health/`);
  });
});

describe('F3: newest signed origin wins and old ones are rejected', () => {
  const signedEnv = (kv = memoryKv()) =>
    env({ ORIGIN_TOPIC: 'topic', ORIGIN_SIGNING_KEY: KEY, COMPASS_ORIGIN: kv });
  const lines = (...m: string[]) => ndjson(...m).split('\n');

  test('a re-posted older message does not beat a newer one posted earlier', async () => {
    const t = now();
    const found = await pickOrigin(
      lines(signed(NEW, t - 60), signed(OLD, t - 3 * 3600)),
      { ORIGIN_SIGNING_KEY: KEY },
      0,
    );
    expect(found).toEqual({ url: NEW, ts: t - 60 });
  });

  test('messages below the floor are rejected', async () => {
    const t = now();
    const found = await pickOrigin(
      lines(signed(OLD, t - 600)),
      { ORIGIN_SIGNING_KEY: KEY },
      t - 60,
    );
    expect(found).toBeNull();
  });

  test('bad signatures, foreign hosts and expired messages are ignored', async () => {
    const t = now();
    const found = await pickOrigin(
      lines(
        signed(NEW, t - 7 * 3600), // older than the window
        signed('https://evil.example/', t), // not a tunnel origin
        signed(OLD, t, 'wrong-key'),
        signed(NEW, t + 3600), // too far in the future
        'not|a|message',
      ),
      { ORIGIN_SIGNING_KEY: KEY },
      0,
    );
    expect(found).toBeNull();
  });

  test('a message just under the watchdog republish interval plus slack is accepted', async () => {
    const t = now();
    // 6 h 1 min: the oldest a healthy watchdog's latest message can be.
    const found = await pickOrigin(
      lines(signed(NEW, t - 6 * 3600 - 60)),
      { ORIGIN_SIGNING_KEY: KEY },
      0,
    );
    expect(found?.url).toBe(NEW);
  });

  test('unsigned mode keeps the last-posted rule', async () => {
    const found = await pickOrigin(lines(NEW, OLD), {}, 0);
    expect(found).toEqual({ url: OLD, ts: null });
  });

  test('unsigned mode persists the origin to KV for a cold isolate', async () => {
    const kv = memoryKv({ url: OLD });
    topic = ndjson(NEW);
    await worker.fetch(new Request(`${PUBLIC}/x`), env({ ORIGIN_TOPIC: 't', COMPASS_ORIGIN: kv }));
    expect(calls[0]!.url).toBe(`${NEW}x`);
    expect(kv.data.get('url')).toBe(NEW);
    // A new isolate whose ntfy poll fails now falls back to the live origin.
    resetStateForTests();
    const okFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://ntfy.sh/')) throw new Error('timeout');
      return okFetch(input, init);
    }) as typeof fetch;
    await worker.fetch(new Request(`${PUBLIC}/y`), env({ ORIGIN_TOPIC: 't', COMPASS_ORIGIN: kv }));
    expect(calls[1]!.url).toBe(`${NEW}y`);
  });

  test('the accepted timestamp and origin are persisted to KV', async () => {
    const t = now();
    const kv = memoryKv();
    topic = ndjson(signed(NEW, t - 60), signed(OLD, t - 3600));
    await worker.fetch(new Request(`${PUBLIC}/x`), signedEnv(kv));
    expect(calls[0]!.url).toBe(`${NEW}x`);
    expect(kv.data.get('signedTs')).toBe(String(t - 60));
    expect(kv.data.get('url')).toBe(NEW);
  });

  test('a fresh isolate honours the KV floor: a replay alone falls back to the persisted origin', async () => {
    const t = now();
    const kv = memoryKv({ signedTs: String(t - 60), url: NEW });
    // The current message has gone from the topic; only the attacker's
    // re-post of the old one is there.
    topic = ndjson(signed(OLD, t - 3600));
    await worker.fetch(new Request(`${PUBLIC}/x`), signedEnv(kv));
    expect(calls[0]!.url).toBe(`${NEW}x`);
    expect(kv.data.get('signedTs')).toBe(String(t - 60));
  });

  test('the per-isolate floor holds even when KV has not caught up', async () => {
    const t = now();
    const kv = memoryKv();
    topic = ndjson(signed(NEW, t - 60));
    await worker.fetch(new Request(`${PUBLIC}/x`), signedEnv(kv));
    // KV is eventually consistent: pretend the write is not visible yet.
    kv.data.clear();
    kv.data.set('url', NEW);
    resetCacheOnly();
    topic = ndjson(signed(OLD, t - 30 * 60));
    await worker.fetch(new Request(`${PUBLIC}/y`), signedEnv(kv));
    expect(calls[1]!.url).toBe(`${NEW}y`);
  });

  test('a newer message for a new tunnel replaces the old origin', async () => {
    const t = now();
    const kv = memoryKv({ signedTs: String(t - 3600), url: OLD });
    topic = ndjson(signed(OLD, t - 3600), signed(NEW, t - 5));
    await worker.fetch(new Request(`${PUBLIC}/x`), signedEnv(kv));
    expect(calls[0]!.url).toBe(`${NEW}x`);
    expect(kv.data.get('signedTs')).toBe(String(t - 5));
  });

  test('ntfy failing after a good read keeps the accepted origin, not stale KV', async () => {
    const t = now();
    const kv = memoryKv();
    topic = ndjson(signed(NEW, t - 60));
    await worker.fetch(new Request(`${PUBLIC}/x`), signedEnv(kv));
    // The KV write is not visible yet and ntfy now times out.
    kv.data.set('url', OLD);
    resetCacheOnly();
    const okFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://ntfy.sh/')) throw new Error('timeout');
      return okFetch(input, init);
    }) as typeof fetch;
    await worker.fetch(new Request(`${PUBLIC}/y`), signedEnv(kv));
    expect(calls[1]!.url).toBe(`${NEW}y`);
  });
});

describe('OPS-15: /__origin takes a server-signed message, never a key', () => {
  const signedEnv = (kv = memoryKv()) =>
    env({ ORIGIN_TOPIC: 'topic', ORIGIN_SIGNING_KEY: KEY, COMPASS_ORIGIN: kv });
  const post = (body: string, e: Record<string, unknown>, headers: Record<string, string> = {}) =>
    worker.fetch(new Request(`${PUBLIC}/__origin`, { method: 'POST', body, headers }), e);

  test('a fresh signed message becomes the origin while the topic is empty', async () => {
    const t = now();
    const kv = memoryKv({ signedTs: String(t - 3600), url: OLD });
    const res = await post(signed(NEW, t - 5), signedEnv(kv));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, url: NEW });
    expect(kv.data.get('url')).toBe(NEW);
    expect(kv.data.get('signedTs')).toBe(String(t - 5));
    await worker.fetch(new Request(`${PUBLIC}/x`), signedEnv(kv));
    expect(calls[0]!.url).toBe(`${NEW}x`);
  });

  test('the old shared-key form is refused and changes nothing', async () => {
    const kv = memoryKv({ url: OLD });
    const res = await post(JSON.stringify({ url: NEW }), signedEnv(kv), {
      'x-origin-key': KEY,
      'content-type': 'application/json',
    });
    expect(res.status).toBe(400);
    expect(kv.data.get('url')).toBe(OLD);
  });

  test('a message older than the origin in use is refused', async () => {
    const t = now();
    const kv = memoryKv({ signedTs: String(t - 60), url: NEW });
    const res = await post(signed(OLD, t - 600), signedEnv(kv));
    expect(res.status).toBe(409);
    expect(kv.data.get('url')).toBe(NEW);
  });

  test('a wrong signature, an expired message, a foreign host or junk is refused', async () => {
    const t = now();
    for (const body of [
      signed(NEW, t, 'wrong-key'),
      signed(NEW, t - 7 * 3600),
      signed('https://evil.example/', t),
      `${NEW}|${t}`,
      'x'.repeat(600),
    ]) {
      const kv = memoryKv({ url: OLD });
      expect((await post(body, signedEnv(kv))).status).toBe(400);
      expect(kv.data.get('url')).toBe(OLD);
    }
  });

  test('without the signing key it is off; only POST is accepted', async () => {
    expect((await post(signed(NEW, now()), env())).status).toBe(503);
    expect((await worker.fetch(new Request(`${PUBLIC}/__origin`), signedEnv())).status).toBe(405);
  });
});

describe('big assets in KV (workers.dev has no Cache API)', () => {
  const IMMUTABLE = 'public, max-age=2592000, immutable';
  /** WebAssembly's magic, then a version. */
  const WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  /** The first bytes of MediaPipe's face_landmarker.task. */
  const TASK = new Uint8Array([0x00, 0x00, 0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
  const INDEX_HTML = '<!doctype html><html><head><title>Compass</title></head></html>';
  function assetKv(initial: Record<string, { value: BodyInit; metadata: unknown }> = {}) {
    const data = new Map(Object.entries(initial));
    return {
      ...memoryKv(),
      data,
      async getWithMetadata(k: string) {
        const hit = data.get(k);
        return hit
          ? { value: new Response(hit.value).body, metadata: hit.metadata }
          : { value: null, metadata: null };
      },
      async put(k: string, v: ArrayBuffer | string, opts?: { metadata?: unknown }) {
        if (typeof v !== 'string') data.set(k, { value: v, metadata: opts?.metadata });
      },
    };
  }
  const answer = (body: BodyInit, type: string) => () =>
    new Response(body, { headers: { 'content-type': type, 'cache-control': IMMUTABLE } });
  const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());

  test('the tracker wasm is fetched from the origin once, then served from KV', async () => {
    const kv = assetKv();
    topic = ndjson(NEW);
    upstream = answer(WASM, 'application/wasm');
    const e = env({ ORIGIN_TOPIC: 't', COMPASS_ORIGIN: kv });
    const first = await worker.fetch(new Request(`${PUBLIC}/assets/vision-1.wasm`), e);
    expect(await bytesOf(first)).toEqual(WASM);
    const second = await worker.fetch(new Request(`${PUBLIC}/assets/vision-1.wasm`), e);
    expect(await bytesOf(second)).toEqual(WASM);
    expect(second.headers.get('content-type')).toBe('application/wasm');
    expect(calls.length).toBe(1);
    expect([...kv.data.keys()]).toEqual(['asset:/assets/vision-1.wasm']);
    // Small assets and pages do not go to KV.
    await worker.fetch(new Request(`${PUBLIC}/assets/index-1.js`), e);
    expect([...kv.data.keys()]).toEqual(['asset:/assets/vision-1.wasm']);
  });

  test('the face model (.task) is kept too', async () => {
    const kv = assetKv();
    topic = ndjson(NEW);
    upstream = answer(TASK, 'application/octet-stream');
    const e = env({ ORIGIN_TOPIC: 't', COMPASS_ORIGIN: kv });
    await worker.fetch(new Request(`${PUBLIC}/assets/face_landmarker-1.task`), e);
    const again = await worker.fetch(new Request(`${PUBLIC}/assets/face_landmarker-1.task`), e);
    expect(await bytesOf(again)).toEqual(TASK);
    expect(calls.length).toBe(1);
  });

  test('OPS-14: a page or an error in place of the file is passed on, never kept', async () => {
    const kv = assetKv();
    topic = ndjson(NEW);
    const e = env({ ORIGIN_TOPIC: 't', COMPASS_ORIGIN: kv });
    const tries: Array<[string, () => Response]> = [
      // index.html for a hash the site does not serve yet.
      ['/assets/vision-2.wasm', answer(INDEX_HTML, 'text/html; charset=UTF-8')],
      // The same, sent as a binary type.
      ['/assets/vision-2.wasm', answer(INDEX_HTML, 'application/wasm')],
      // Not a page, but not WebAssembly either.
      ['/assets/vision-2.wasm', answer('Not Found', 'application/wasm')],
      ['/assets/face_landmarker-2.task', answer(INDEX_HTML, 'application/octet-stream')],
      ['/assets/face_landmarker-2.task', answer('{"code":"NOT_FOUND"}', 'application/json')],
    ];
    for (const [path, origin] of tries) {
      upstream = origin;
      const res = await worker.fetch(new Request(`${PUBLIC}${path}`), e);
      expect(res.status).toBe(200);
      await res.arrayBuffer();
    }
    expect(kv.data.size).toBe(0);
    // Each one went to the origin: nothing answered from KV.
    expect(calls.length).toBe(tries.length);
  });

  test('a page kept in KV before the check is not served; the file is fetched again', async () => {
    const kv = assetKv({
      'asset:/assets/vision-3.wasm': {
        value: INDEX_HTML,
        metadata: { type: 'text/html; charset=UTF-8' },
      },
    });
    topic = ndjson(NEW);
    upstream = answer(WASM, 'application/wasm');
    const e = env({ ORIGIN_TOPIC: 't', COMPASS_ORIGIN: kv });
    const res = await worker.fetch(new Request(`${PUBLIC}/assets/vision-3.wasm`), e);
    expect(await bytesOf(res)).toEqual(WASM);
    expect(calls.length).toBe(1);
    // The good copy replaced the page.
    expect(kv.data.get('asset:/assets/vision-3.wasm')!.metadata).toEqual({
      type: 'application/wasm',
    });
  });
});

describe('edge cache for hashed assets', () => {
  test('an immutable /assets/ file is fetched from the origin once', async () => {
    const store = new Map<string, Response>();
    const g = globalThis as unknown as { caches?: unknown };
    const before = g.caches;
    g.caches = {
      default: {
        async match(req: Request) {
          return store.get(req.url)?.clone();
        },
        async put(req: Request, res: Response) {
          store.set(req.url, res);
        },
      },
    };
    try {
      topic = ndjson(NEW);
      upstream = () =>
        new Response('wasm bytes', {
          headers: { 'cache-control': 'public, max-age=2592000, immutable' },
        });
      const e = env({ ORIGIN_TOPIC: 't' });
      const first = await worker.fetch(new Request(`${PUBLIC}/assets/a-1.js?x=1`), e);
      expect(await first.text()).toBe('wasm bytes');
      const second = await worker.fetch(new Request(`${PUBLIC}/assets/a-1.js`), e);
      expect(await second.text()).toBe('wasm bytes');
      expect(calls.length).toBe(1);
      // Pages and API calls are never cached.
      upstream = () => new Response('page', { headers: { 'cache-control': 'no-store' } });
      await worker.fetch(new Request(`${PUBLIC}/`), e);
      await worker.fetch(new Request(`${PUBLIC}/`), e);
      expect(calls.length).toBe(3);
      // OPS-14: nor is index.html sent for an /assets/ file, immutable or not.
      upstream = () =>
        new Response('<!doctype html>', {
          headers: {
            'content-type': 'text/html; charset=UTF-8',
            'cache-control': 'public, max-age=2592000, immutable',
          },
        });
      await worker.fetch(new Request(`${PUBLIC}/assets/b-2.js`), e);
      await worker.fetch(new Request(`${PUBLIC}/assets/b-2.js`), e);
      expect(calls.length).toBe(5);
      expect([...store.keys()]).toEqual([`${PUBLIC}/assets/a-1.js`]);
    } finally {
      g.caches = before;
    }
  });
});

// Expire only the 30 s origin cache, keeping the per-isolate floor.
function resetCacheOnly() {
  const realNow = Date.now;
  const later = realNow() + 31_000;
  Date.now = () => later;
  afterEachRestore.push(() => {
    Date.now = realNow;
  });
}
const afterEachRestore: Array<() => void> = [];
afterEach(() => {
  for (const f of afterEachRestore.splice(0)) f();
});

describe('OPS-28: no wait for ntfy once an origin is known, and no dead fallback host', () => {
  const host = (call: Call | undefined) => (call ? new URL(call.url).host : null);

  test('a stale origin answers at once and is refreshed in the background', async () => {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
    const e = env({ ORIGIN_TOPIC: 't', ORIGIN_URL: undefined });
    topic = ndjson(OLD);
    // A cold isolate has nothing to answer with, so it waits for ntfy.
    await worker.fetch(new Request(`${PUBLIC}/a`), e, ctx);
    expect(host(calls.at(-1))).toBe(new URL(OLD).host);
    expect(pending).toHaveLength(0);

    topic = ndjson(NEW);
    resetCacheOnly();
    await worker.fetch(new Request(`${PUBLIC}/b`), e, ctx);
    // Answered from the origin it had; one refresh queued, not one per request.
    expect(host(calls.at(-1))).toBe(new URL(OLD).host);
    await worker.fetch(new Request(`${PUBLIC}/c`), e, ctx);
    expect(pending).toHaveLength(1);

    await Promise.all(pending);
    await worker.fetch(new Request(`${PUBLIC}/d`), e, ctx);
    expect(host(calls.at(-1))).toBe(new URL(NEW).host);
  });

  test('without ctx (no waitUntil) the refresh happens before the answer, as before', async () => {
    const e = env({ ORIGIN_TOPIC: 't', ORIGIN_URL: undefined });
    topic = ndjson(OLD);
    await worker.fetch(new Request(`${PUBLIC}/a`), e);
    topic = ndjson(NEW);
    resetCacheOnly();
    await worker.fetch(new Request(`${PUBLIC}/b`), e);
    expect(host(calls.at(-1))).toBe(new URL(NEW).host);
  });

  test('nothing published, nothing in KV, no ORIGIN_URL: 503 and no upstream request', async () => {
    const res = await worker.fetch(new Request(`${PUBLIC}/x`), env({ ORIGIN_URL: undefined }));
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });
});
