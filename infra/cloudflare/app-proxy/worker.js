/**
 * Stable HTTPS entry point for a server that only exposes HTTP.
 *
 * The deployment has a fixed IP but no owned domain. A workers.dev
 * hostname gives Telegram and browsers a stable HTTPS origin without
 * opening 443 on the origin or buying DNS. The Worker is intentionally
 * a transparent reverse proxy; authentication and tenant isolation
 * remain in the Compass API.
 *
 * The quick tunnel in front of nginx can change hostname after a
 * restart. The server-side watchdog POSTs the new hostname to
 * `/__origin`; it is stored in KV and picked up here without changing
 * the public URL.
 *
 * 2026-10-21 audit CA-12: the ntfy topic is public to anyone who knows
 * its name, and whoever can post to it could point the whole app at
 * their own trycloudflare host. When the ORIGIN_SIGNING_KEY secret is
 * set, a message is accepted only as `<url>|<unix_ts>|<hex hmac>` where
 * hmac = HMAC-SHA256(key, `<url>|<unix_ts>`), signed by
 * infra/tunnel/compass-origin-watch.sh. Without the secret the old
 * unsigned behaviour stays (with a one-time warning), so the server
 * script and this Worker can be rolled out in either order.
 *
 * 2026-10-31 security scan F3: a signed message stays valid for its
 * whole age window, and anyone can re-post one to the topic. So the
 * Worker no longer takes the last-posted valid message but the one with
 * the largest signed timestamp, keeps the highest timestamp it ever
 * accepted (KV `signedTs`, plus a per-isolate copy) and rejects anything
 * older. A replayed message for a dead tunnel can then never displace a
 * newer one.
 */
const ORIGIN_CACHE_MS = 30_000;
// The watchdog (infra/tunnel/compass-origin-watch.sh) republishes every
// 6 h (republish_after_seconds=21600) from a once-a-minute timer, so a
// healthy topic always holds a message younger than 6 h + 1 min. 30 min
// of slack covers a slow or briefly failing publish; past that the
// Worker serves the last accepted origin from KV (F3, 2026-10-31; was 7
// days).
const ORIGIN_SIGNATURE_MAX_AGE_S = 6 * 60 * 60 + 30 * 60;
const ORIGIN_SIGNATURE_MAX_SKEW_S = 5 * 60;
let originCache = { url: null, readAt: 0 };
// Highest signed timestamp this isolate has accepted (F3). KV `signedTs`
// carries it across isolates and deploys; this copy covers a KV read
// that is still eventually consistent.
let highestSignedTs = 0;
let warnedUnsigned = false;
const encoder = new TextEncoder();

/**
 * Constant-time string comparison (CA-12). Length is not secret; the
 * content is compared without an early exit so response timing does not
 * reveal how much of a guessed key was right.
 */
function timingSafeEqual(a, b) {
  const x = encoder.encode(String(a ?? ''));
  const y = encoder.encode(String(b ?? ''));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i += 1) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function hmacHex(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isTunnelOrigin(candidate) {
  return (
    candidate.protocol === 'https:' &&
    candidate.hostname.endsWith('.trycloudflare.com') &&
    candidate.pathname === '/' &&
    !candidate.search &&
    !candidate.hash
  );
}

/**
 * Turn one ntfy message into `{ url, ts }`, or null if it must be
 * ignored. Signed form: `<url>|<ts>|<sig>` (ts is the signed unix time);
 * unsigned: `<url>` (ts is null).
 */
async function originFromMessage(message, env) {
  const parts = message.trim().split('|');
  if (env.ORIGIN_SIGNING_KEY) {
    if (parts.length !== 3) return null;
    const [url, ts, sig] = parts;
    if (!/^\d{1,12}$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig)) return null;
    const age = Math.floor(Date.now() / 1000) - Number(ts);
    if (age > ORIGIN_SIGNATURE_MAX_AGE_S || age < -ORIGIN_SIGNATURE_MAX_SKEW_S) return null;
    const expected = await hmacHex(env.ORIGIN_SIGNING_KEY, `${url}|${ts}`);
    if (!timingSafeEqual(expected, sig)) return null;
    const candidate = new URL(url);
    return isTunnelOrigin(candidate) ? { url: candidate.toString(), ts: Number(ts) } : null;
  }
  if (!warnedUnsigned) {
    warnedUnsigned = true;
    console.warn(
      'ORIGIN_SIGNING_KEY is not set: accepting unsigned ntfy origin messages (CA-12). ' +
        'Run `wrangler secret put ORIGIN_SIGNING_KEY`.',
    );
  }
  // Unsigned mode also accepts the signed format (ignoring the
  // signature) so a server that already signs keeps working while this
  // Worker has no secret yet.
  if (parts.length !== 1 && parts.length !== 3) return null;
  const candidate = new URL(parts[0]);
  return isTunnelOrigin(candidate) ? { url: candidate.toString(), ts: null } : null;
}

/**
 * Pick the origin from the topic's ndjson lines, or null.
 *
 * Signed mode (F3): the valid message with the largest signed timestamp
 * that is not older than `floorTs`, whatever order it was posted in.
 * Unsigned mode keeps the old rule: the last-posted valid message.
 */
async function pickOrigin(lines, env, floorTs) {
  let best = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const event = JSON.parse(lines[i]);
      if (event?.event !== 'message' || typeof event.message !== 'string') continue;
      const found = await originFromMessage(event.message, env);
      if (!found) continue;
      if (found.ts === null) return found;
      if (found.ts < floorTs) continue;
      if (!best || found.ts > best.ts) best = found;
    } catch {
      // Ignore malformed/foreign/unsigned messages in the topic.
    }
  }
  return best;
}

/**
 * Build the upstream URL from the origin and the client's path and query
 * only (F4, 2026-10-31). Resolving the path as a relative URL let `//host`
 * or `/\host` replace the origin host. Returns null if the result would
 * still leave the origin host.
 */
function proxyTarget(incoming, origin) {
  const target = new URL(origin.origin);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  return target.host === origin.host ? target : null;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}

async function currentOrigin(env) {
  if (originCache.url && Date.now() - originCache.readAt < ORIGIN_CACHE_MS) {
    return originCache.url;
  }

  // The server cannot reach workers.dev, so it publishes the current
  // quick-tunnel hostname to a private ntfy topic. This is the primary
  // rendezvous; KV/env remain a manual fallback.
  if (env.ORIGIN_TOPIC) {
    try {
      const response = await fetch(
        `https://ntfy.sh/${encodeURIComponent(env.ORIGIN_TOPIC)}/json?poll=1&since=all`,
        {
          headers: { accept: 'application/x-ndjson' },
          signal: AbortSignal.timeout(2500),
        },
      );
      if (response.ok) {
        const lines = (await response.text()).trim().split('\n');
        let floorTs = highestSignedTs;
        if (env.ORIGIN_SIGNING_KEY) {
          try {
            floorTs = Math.max(floorTs, Number(await env.COMPASS_ORIGIN.get('signedTs')) || 0);
          } catch {
            // KV unavailable: the per-isolate floor still applies.
          }
        }
        highestSignedTs = floorTs;
        const found = await pickOrigin(lines, env, floorTs);
        if (found) {
          if (found.ts !== null && found.ts > floorTs) {
            highestSignedTs = found.ts;
            try {
              // Also the KV fallback below, so a topic that holds no
              // fresh message (watchdog late, ntfy down) still serves the
              // newest origin rather than a stale manual or wrangler.toml
              // one.
              await env.COMPASS_ORIGIN.put('signedTs', String(found.ts));
              await env.COMPASS_ORIGIN.put('url', found.url);
            } catch (error) {
              console.warn('could not persist the accepted origin to KV', error);
            }
          }
          originCache = { url: found.url, readAt: Date.now() };
          return found.url;
        }
      }
    } catch {
      // Fall through to KV/env while ntfy is unavailable.
    }
  }

  const stored = await env.COMPASS_ORIGIN.get('url');
  const url = stored || env.ORIGIN_URL;
  originCache = { url, readAt: Date.now() };
  return url;
}

export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);

    if (incoming.pathname === '/__origin') {
      if (request.method !== 'POST') return json({ ok: false, error: 'use POST' }, 405);
      if (!env.ORIGIN_UPDATE_KEY) {
        return json({ ok: false, error: 'watchdog secret is not configured' }, 503);
      }
      if (!timingSafeEqual(request.headers.get('x-origin-key'), env.ORIGIN_UPDATE_KEY)) {
        return json({ ok: false, error: 'forbidden' }, 403);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: 'invalid json' }, 400);
      }
      let candidate;
      try {
        candidate = new URL(String(body?.url ?? ''));
      } catch {
        return json({ ok: false, error: 'invalid url' }, 400);
      }
      if (!isTunnelOrigin(candidate)) {
        return json({ ok: false, error: 'origin must be a trycloudflare origin' }, 400);
      }
      await env.COMPASS_ORIGIN.put('url', candidate.toString());
      originCache = { url: candidate.toString(), readAt: Date.now() };
      return json({ ok: true, url: candidate.toString() });
    }

    const origin = new URL(await currentOrigin(env));
    const target = proxyTarget(incoming, origin);
    if (!target) return json({ ok: false, error: 'bad request path' }, 400);

    const headers = new Headers(request.headers);
    // AUTH-6 (2026-10-30): the origin cannot tell clients apart — on the
    // tunnel hop `cf-connecting-ip` names this Worker, and
    // `x-forwarded-for` is whatever the client wrote. Here Cloudflare's
    // `cf-connecting-ip` is the real client. Pass it on with the shared
    // secret so the API's rate limiter can trust it; never pass on a
    // client's own copy of either header.
    headers.delete('x-compass-client-ip');
    headers.delete('x-compass-proxy-key');
    if (env.CLIENT_IP_PROXY_KEY) {
      const clientIp = request.headers.get('cf-connecting-ip');
      if (clientIp) headers.set('x-compass-client-ip', clientIp);
      headers.set('x-compass-proxy-key', env.CLIENT_IP_PROXY_KEY);
    }
    headers.set('x-forwarded-host', incoming.host);
    headers.set('x-forwarded-proto', 'https');
    // Avoid forwarding the Workers hostname as the origin Host header.
    headers.set('host', origin.host);

    const init = {
      method: request.method,
      headers,
      redirect: 'manual',
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body;
    }

    const response = await fetch(target, init);
    const responseHeaders = new Headers(response.headers);

    // Nginx may answer /health with a trailing-slash redirect. Keep
    // every redirect on the public HTTPS hostname instead of leaking
    // the private HTTP origin to the browser.
    const location = responseHeaders.get('location');
    if (location) {
      try {
        const resolved = new URL(location, origin);
        if (resolved.host === origin.host) {
          resolved.protocol = 'https:';
          resolved.host = incoming.host;
          responseHeaders.set('location', resolved.toString());
        }
      } catch {
        // Leave an opaque Location header untouched.
      }
    }

    // A 101 (WebSocket upgrade) cannot be rebuilt with `new Response` —
    // the constructor only takes 200–599 and throws, so realtime never
    // connected through this proxy. Hand the upgrade back untouched.
    if (response.status === 101 || response.webSocket) return response;

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  },
};

// Test seams (scripts/__tests__/appProxyWorker.test.ts). Workers only
// call the default export.
export { pickOrigin, proxyTarget };
export function resetStateForTests() {
  originCache = { url: null, readAt: 0 };
  highestSignedTs = 0;
  warnedUnsigned = false;
}
