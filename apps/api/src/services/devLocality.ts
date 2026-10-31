/**
 * Is this request from the developer's own machine or LAN? Gates the dev
 * persona and bypass logins (D21, 2026-10-31; RE-ENG-3, security scan F5).
 *
 * It used to be enough for `Host`, `Origin` or `X-Forwarded-Host` to name
 * localhost, or for `cf-connecting-ip` / `x-forwarded-for` to say
 * 127.0.0.1. A client writes all of those itself, so any dev or QA API
 * reachable from outside handed out admin tokens to anyone who sent
 * `Origin: http://localhost`.
 *
 * Now only the socket's real peer address counts (Bun's
 * `server.requestIP(req)`, passed in by main.ts):
 *   - it must be loopback or a private LAN range (10/8, 172.16/12,
 *     192.168/16, fc00::/7, ::1), so the Fine phone build on the Wi-Fi
 *     still reaches the dev API directly;
 *   - and the request must carry none of the headers a proxy or
 *     Cloudflare adds (`cf-connecting-ip`, `cf-ray`, `x-forwarded-for`).
 *     cloudflared and nginx connect from 127.0.0.1, so without this a
 *     request through a quick tunnel would look local.
 * Host, Origin and X-Forwarded-Host no longer count either way.
 */
import { isIP } from 'node:net';

type HeaderReader = (name: string) => string | undefined;

/** Headers whose presence means a proxy relayed the request. */
export const PROXY_HEADERS = ['cf-connecting-ip', 'cf-ray', 'x-forwarded-for'] as const;

function ipv4Octets(ip: string): number[] | null {
  if (isIP(ip) !== 4) return null;
  return ip.split('.').map(Number);
}

function isLocalIpv4(ip: string): boolean {
  const o = ipv4Octets(ip);
  if (!o) return false;
  const [a, b] = o as [number, number, number, number];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Loopback or a private LAN address (IPv4, IPv6, or IPv4-mapped IPv6). */
export function isLocalPeerAddress(raw: string | null | undefined): boolean {
  const ip = raw?.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!ip) return false;
  const family = isIP(ip);
  if (family === 4) return isLocalIpv4(ip);
  if (family !== 6) return false;
  if (ip === '::1') return true;
  // ::ffff:a.b.c.d — Bun reports this on a dual-stack listener.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isLocalIpv4(mapped[1]!);
  // fc00::/7: the first group is fcXX or fdXX (a shorter group like
  // `fc::` is 00fc and outside the range).
  return /^f[cd][0-9a-f]{2}:/.test(ip);
}

/** True only for a direct connection from this machine or the LAN. */
export function isLocalDevPeer(peerIp: string | null | undefined, header: HeaderReader): boolean {
  if (PROXY_HEADERS.some((name) => header(name) !== undefined)) return false;
  return isLocalPeerAddress(peerIp);
}
