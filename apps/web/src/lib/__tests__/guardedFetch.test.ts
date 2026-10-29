import { afterEach, describe, expect, it } from 'bun:test';
import { guardedFetch } from '../trpc';
import { isLikelyNetworkError } from '../networkError';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(impl: (init: RequestInit | undefined) => Promise<Response>) {
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => impl(init)) as typeof fetch;
}

describe('guardedFetch (N3/N5)', () => {
  it('turns a proxy error page into a network failure', async () => {
    stubFetch(async () => new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
    const err = await guardedFetch('/trpc/x', { method: 'POST' }).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(isLikelyNetworkError(err)).toBe(true);
  });

  it("passes the API's own JSON error through", async () => {
    stubFetch(async () => new Response('{"error":{}}', { status: 503, headers: { 'content-type': 'application/json' } }));
    const res = await guardedFetch('/trpc/x', {});
    expect(res.status).toBe(503);
  });

  it('times out a request that never answers, as a network failure', async () => {
    stubFetch(
      (init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const err = await guardedFetch('/trpc/x', { method: 'POST' }, 30).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(isLikelyNetworkError(err)).toBe(true);
  });

  it("keeps the caller's own abort an abort", async () => {
    stubFetch(
      (init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const caller = new AbortController();
    const pending = guardedFetch('/trpc/x', { signal: caller.signal }, 5_000).catch((e) => e);
    caller.abort();
    const err = await pending;
    expect((err as DOMException).name).toBe('AbortError');
  });

  it('returns ordinary answers untouched', async () => {
    stubFetch(async () => new Response('{"result":{}}', { status: 200, headers: { 'content-type': 'application/json' } }));
    expect((await guardedFetch('/trpc/x', {})).status).toBe(200);
  });
});
