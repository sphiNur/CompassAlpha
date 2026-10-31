/**
 * The /ws handshake (realtime/socket.ts) against a real Bun.serve, with
 * stubbed token verification and session lookup — no database needed.
 *
 *   - RE-ENG-4 (2026-10-30): a plain GET with a valid token was answered
 *     500 "upgrade failed"; it is a client mistake and gets 426.
 *   - N1 (2026-10-30): `?probe=1` without a token upgrades, says hello,
 *     echoes the client's message and closes 4002, so the deploy smoke can prove the
 *     upgrade crosses the proxies without a production token. The probe
 *     never joins the hub.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { hub } from '../realtime/hub';
import {
  createWebSocketHandler,
  handleWsRequest,
  WS_CLOSE_PROBE,
  type WSData,
} from '../realtime/socket';

const ORG = '00000000-0000-4000-8000-0000000000aa';
const quietLog = { debug: () => {} };

let server: Server<WSData>;
let base: string;
let lookups = 0;

beforeAll(() => {
  server = Bun.serve<WSData>({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      return handleWsRequest(req, srv, {
        verifyAccess: async (token) => {
          if (token === 'good' || token === 'gone') return { sub: 'u1', org: ORG, mid: 'm1' };
          throw new Error('bad');
        },
        // 'gone' stands for a member removed after the token was issued.
        loadSession: async () => {
          lookups++;
          return lastToken === 'gone' ? null : {};
        },
      });
    },
    websocket: createWebSocketHandler(quietLog),
  });
  base = `127.0.0.1:${server.port}`;
});
afterAll(() => {
  server.stop(true);
});

// The stub above needs to know which token the test sent.
let lastToken = '';
function plainGet(query: string, headers: Record<string, string> = {}) {
  lastToken = new URLSearchParams(query).get('token') ?? '';
  return fetch(`http://${base}/ws${query}`, { headers });
}

interface Outcome {
  opened: boolean;
  frames: string[];
  code: number | null;
}
function connect(query: string): Promise<Outcome> {
  lastToken = new URLSearchParams(query).get('token') ?? '';
  return new Promise((resolve) => {
    const out: Outcome = { opened: false, frames: [], code: null };
    const ws = new WebSocket(`ws://${base}/ws${query}`);
    ws.addEventListener('open', () => {
      out.opened = true;
    });
    ws.addEventListener('message', (e) => {
      out.frames.push(String(e.data));
      // A real socket stays open; record the hello and hang up. A probe
      // answers its hello with a message, as the deploy smoke does.
      if (!String(e.data).includes('"probe"')) ws.close(1000);
      else if (String(e.data).includes('"hello"')) ws.send(JSON.stringify({ type: 'ping' }));
    });
    ws.addEventListener('close', (e) => {
      out.code = e.code;
      resolve(out);
    });
  });
}

describe('/ws handshake', () => {
  test('RE-ENG-4: valid token without an Upgrade header is 426, not 500', async () => {
    const before = lookups;
    const r = await plainGet('?token=good');
    expect(r.status).toBe(426);
    expect(r.headers.get('upgrade')).toBe('websocket');
    // Answered before any session lookup is spent on it.
    expect(lookups).toBe(before);
  });

  test('plain GET without a token is 426 too', async () => {
    expect((await plainGet('')).status).toBe(426);
    expect((await plainGet('?probe=1')).status).toBe(426);
  });

  test('an Upgrade header with a malformed handshake is 400, not 500', async () => {
    const r = await plainGet('?token=good', { upgrade: 'websocket', connection: 'Upgrade' });
    expect(r.status).toBe(400);
  });

  test('upgrade attempts keep their auth refusals', async () => {
    const headers = {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
    };
    expect((await plainGet('', headers)).status).toBe(401);
    expect((await plainGet('?token=nope', headers)).status).toBe(401);
    expect((await plainGet('?token=gone', headers)).status).toBe(403);
  });

  test('a real client with a valid token opens and gets the hello', async () => {
    const o = await connect('?token=good');
    expect(o.opened).toBe(true);
    expect(JSON.parse(o.frames[0]!).type).toBe('ping');
  });

  test('N1: the token-less probe says hello, echoes a message and closes 4002', async () => {
    const subsBefore = hub.size(ORG);
    const o = await connect('?probe=1');
    expect(o.opened).toBe(true);
    expect(o.frames.map((f) => JSON.parse(f).stage)).toEqual(['hello', 'echo']);
    expect(o.code).toBe(WS_CLOSE_PROBE);
    // (the previous test's socket may still be closing server-side)
    expect(hub.size(ORG)).toBeLessThanOrEqual(subsBefore);
    expect(hub.size('')).toBe(0);
  });

  test('a token-less upgrade without probe=1 is still refused', async () => {
    const o = await connect('');
    expect(o.opened).toBe(false);
  });
});
