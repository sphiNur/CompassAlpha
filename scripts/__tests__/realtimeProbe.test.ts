/**
 * The deploy smoke's realtime probe (scripts/lib/realtimeProbe.ts) must
 * pass against a healthy API and FAIL — with a reason that says which
 * side broke — against the setups that used to read as green (N1).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { probeRealtime, probeUrl } from '../lib/realtimeProbe';
import {
  createWebSocketHandler,
  handleWsRequest,
  type WSData,
} from '../../apps/api/src/realtime/socket';

const servers: Server<unknown>[] = [];
function url(s: Server<unknown>) {
  return `http://127.0.0.1:${s.port}`;
}

let api: Server<WSData>;
beforeAll(() => {
  // The real /ws handler; auth is irrelevant to the token-less probe.
  api = Bun.serve<WSData>({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      const p = new URL(req.url).pathname;
      if (p === '/ws') {
        return handleWsRequest(req, srv, {
          verifyAccess: async () => {
            throw new Error('no tokens here');
          },
          loadSession: async () => null,
        });
      }
      return new Response('api', { status: 200 });
    },
    websocket: createWebSocketHandler({ debug: () => {} }),
  });
  servers.push(api);
});
afterAll(() => {
  for (const s of servers) s.stop(true);
});

/** A plain HTTP reverse proxy in front of the API. */
function proxy(rewrite: (h: Headers) => void, rewrap: boolean): Server<unknown> {
  const s = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const u = new URL(req.url);
      const headers = new Headers(req.headers);
      rewrite(headers);
      const r = await fetch(url(api) + u.pathname + u.search, { headers, redirect: 'manual' });
      // The N1 Worker bug: rebuilding every response, a 101 included.
      return rewrap ? new Response(r.body, { status: r.status, headers: r.headers }) : r;
    },
  });
  servers.push(s);
  return s;
}

describe('realtime probe', () => {
  test('probe URL keeps the scheme family and adds probe=1', () => {
    expect(probeUrl('https://x.workers.dev/')).toBe('wss://x.workers.dev/ws?probe=1');
    expect(probeUrl('http://localhost:3999')).toBe('ws://localhost:3999/ws?probe=1');
  });

  test('passes against a healthy API', async () => {
    const r = await probeRealtime(url(api), 3000);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('closed 4002');
  });

  test('fails when a proxy drops the Upgrade header, and says the API is reachable', async () => {
    const p = proxy((h) => {
      h.delete('upgrade');
      h.delete('connection');
    }, false);
    const r = await probeRealtime(url(p), 3000);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('reaches the API (426)');
  });

  test('fails when a proxy rebuilds every response (the N1 Worker)', async () => {
    const p = proxy(() => {}, true);
    const r = await probeRealtime(url(p), 3000);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('upgrade failed');
  });

  test('fails when /ws is answered by something that is not the API', async () => {
    const spa = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }),
    });
    servers.push(spa);
    const r = await probeRealtime(url(spa), 3000);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('-> 200');
  });

  test('fails when nothing listens', async () => {
    const dead = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
    const deadUrl = url(dead);
    dead.stop(true);
    const r = await probeRealtime(deadUrl, 3000);
    expect(r.ok).toBe(false);
  });
});
