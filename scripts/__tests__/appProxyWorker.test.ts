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
