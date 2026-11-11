/**
 * The Telegram relay Worker (infra/cloudflare/tg-relay/worker.js), review
 * OPS-27 (2026-11-11): the shared key gates every request, and only the
 * Bot API methods the server calls get through — setWebhook would let a
 * key holder take over the bot's incoming messages.
 *
 * fetch is stubbed; nothing reaches Telegram or Cloudflare. The error
 * texts are the ones apps/worker/src/relay.ts tells apart from the Bot
 * API's own answers, so they stay as they are.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import worker from '../../infra/cloudflare/tg-relay/worker.js';

const KEY = 'a'.repeat(64);
const env = { COMPASS_RELAY_KEY: KEY, BOT_TOKEN: '123:token' };

type Call = { url: string; init?: RequestInit };
const realFetch = globalThis.fetch;
let calls: Call[] = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response('{"ok":true,"result":{}}', { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function relay(body: unknown, opts: { key?: string | null; method?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const key = opts.key === undefined ? KEY : opts.key;
  if (key !== null) headers['x-compass-key'] = key;
  const method = opts.method ?? 'POST';
  return new Request('https://tg-relay.example.workers.dev/', {
    method,
    headers,
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
}

const send = { method: 'sendMessage', params: { chat_id: 1, text: 'hi' } };

describe('the shared key', () => {
  test('a request with the key reaches the Bot API', async () => {
    const res = await worker.fetch(relay(send), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true,"result":{}}');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.telegram.org/bot123:token/sendMessage');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ chat_id: 1, text: 'hi' });
  });

  test('no key, a wrong key, a prefix of the key or a longer one is refused', async () => {
    for (const key of [null, '', 'b'.repeat(64), KEY.slice(0, 63), KEY + 'a']) {
      const res = await worker.fetch(relay(send, { key }), env);
      expect([key, res.status, await res.text()]).toEqual([key, 403, 'forbidden']);
    }
    expect(calls).toHaveLength(0);
  });

  test('a Worker without a key configured refuses everything', async () => {
    const res = await worker.fetch(relay(send, { key: '' }), { ...env, COMPASS_RELAY_KEY: '' });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe('the methods (OPS-27)', () => {
  test('only sendMessage gets through', async () => {
    for (const method of [
      'setWebhook',
      'deleteWebhook',
      'getMe',
      'getUpdates',
      'editMessageText',
      '../x',
    ]) {
      const res = await worker.fetch(relay({ method, params: {} }), env);
      expect([method, res.status]).toEqual([method, 400]);
      expect(await res.text()).toBe(`method not allowed: ${method}`);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('everything else', () => {
  test('GET is refused', async () => {
    const res = await worker.fetch(relay(undefined, { method: 'GET' }), env);
    expect(res.status).toBe(405);
  });

  test('a body that is not JSON', async () => {
    const res = await worker.fetch(relay('{not json'), env);
    expect([res.status, await res.text()]).toEqual([400, 'invalid json']);
  });

  test('a Worker without BOT_TOKEN says so', async () => {
    const res = await worker.fetch(relay(send), { ...env, BOT_TOKEN: '' });
    expect(res.status).toBe(500);
    expect(calls).toHaveLength(0);
  });

  test("the Bot API's own refusal comes back as it is", async () => {
    const blocked =
      '{"ok":false,"error_code":403,"description":"Forbidden: bot was blocked by the user"}';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(blocked, { status: 403 });
    }) as typeof fetch;
    const res = await worker.fetch(relay(send), env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      ok: false,
      error_code: 403,
      description: 'Forbidden: bot was blocked by the user',
    });
  });
});
