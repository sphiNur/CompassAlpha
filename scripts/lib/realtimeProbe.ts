/**
 * Realtime (WebSocket) probe for the deploy smoke — N1, 2026-10-30.
 *
 * The smoke used to send a token-less plain GET to /ws and count any 4xx
 * as a pass. That never attempts an upgrade, so a proxy that breaks the
 * 101 handshake (N1: the Cloudflare Worker re-wrapped the 101 and threw,
 * and every client silently fell back to polling) still read as DEPLOY
 * GREEN.
 *
 * The smoke has no production token, so the API offers a token-less probe:
 * `GET /ws?probe=1` with a real upgrade is accepted, sent one
 * `{"type":"probe"}` frame and closed with code 4002
 * (apps/api/src/realtime/socket.ts). Seeing all three through the public
 * URL proves the upgrade, a server→client frame and the close frame cross
 * every proxy in front of the API. When the upgrade does not complete, a
 * plain GET /ws tells the two failure kinds apart:
 *
 *   426 from the API  → the API is reachable over HTTP, but the upgrade
 *                       did not survive the proxy chain (Upgrade header
 *                       dropped, 101 rewritten, …);
 *   anything else     → /ws does not reach this API at all.
 */

/** Must match WS_CLOSE_PROBE in apps/api/src/realtime/socket.ts. */
export const WS_CLOSE_PROBE = 4002;

export interface RealtimeProbeResult {
  ok: boolean;
  detail: string;
}

export function probeUrl(base: string): string {
  const u = new URL(base.replace(/\/$/, '') + '/ws');
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.searchParams.set('probe', '1');
  return u.toString();
}

interface SocketOutcome {
  opened: boolean;
  probeFrame: boolean;
  closeCode: number | null;
  timedOut: boolean;
}

function openProbe(url: string, timeoutMs: number): Promise<SocketOutcome> {
  return new Promise((resolve) => {
    const out: SocketOutcome = {
      opened: false,
      probeFrame: false,
      closeCode: null,
      timedOut: false,
    };
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      resolve(out);
      return;
    }
    const timer = setTimeout(() => {
      out.timedOut = true;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      resolve(out);
    }, timeoutMs);
    ws.addEventListener('open', () => {
      out.opened = true;
    });
    ws.addEventListener('message', (e) => {
      try {
        const msg = JSON.parse(String(e.data)) as { type?: string };
        if (msg.type === 'probe') out.probeFrame = true;
      } catch {
        /* not ours */
      }
    });
    ws.addEventListener('close', (e) => {
      clearTimeout(timer);
      out.closeCode = e.code;
      resolve(out);
    });
  });
}

async function plainGetStatus(base: string): Promise<string> {
  try {
    const r = await fetch(base.replace(/\/$/, '') + '/ws', {
      headers: { 'cache-control': 'no-cache' },
      redirect: 'manual',
    });
    const body = (await r.text()).slice(0, 60).replace(/\s+/g, ' ');
    return r.status === 426
      ? 'plain GET /ws reaches the API (426) — the upgrade is lost between the public URL and the API (proxy drops the Upgrade header or rewrites the 101)'
      : `plain GET /ws -> ${r.status} "${body}" — /ws does not reach this API at all`;
  } catch (err) {
    return `plain GET /ws failed too: ${(err as Error).message}`;
  }
}

export async function probeRealtime(
  base: string,
  timeoutMs = 10_000,
): Promise<RealtimeProbeResult> {
  const url = probeUrl(base);
  const o = await openProbe(url, timeoutMs);
  if (o.opened && o.probeFrame && o.closeCode === WS_CLOSE_PROBE) {
    return {
      ok: true,
      detail: `${url}: upgraded (101), probe frame received, closed ${WS_CLOSE_PROBE}`,
    };
  }
  if (o.opened) {
    // Upgraded, but not by this API's probe path — e.g. an API build from
    // before the probe existed, or something else answering /ws.
    return {
      ok: false,
      detail:
        `${url}: upgraded but ${o.probeFrame ? 'closed' : 'no probe frame,'} ` +
        `${o.timedOut ? `still open after ${timeoutMs} ms` : `close code ${o.closeCode}`} ` +
        `(expected probe frame + ${WS_CLOSE_PROBE}; is the API older than the probe?)`,
    };
  }
  const why = o.timedOut ? `no answer in ${timeoutMs} ms` : `close code ${o.closeCode ?? 'none'}`;
  return { ok: false, detail: `${url}: upgrade failed (${why}); ${await plainGetStatus(base)}` };
}
