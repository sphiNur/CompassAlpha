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
 */
const ORIGIN_CACHE_MS = 30_000;
let originCache = { url: null, readAt: 0 };

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
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          try {
            const event = JSON.parse(lines[i]);
            if (event?.event !== 'message' || typeof event.message !== 'string') continue;
            const candidate = new URL(event.message.trim());
            if (
              candidate.protocol === 'https:' &&
              candidate.hostname.endsWith('.trycloudflare.com') &&
              candidate.pathname === '/' &&
              !candidate.search &&
              !candidate.hash
            ) {
              originCache = { url: candidate.toString(), readAt: Date.now() };
              return candidate.toString();
            }
          } catch {
            // Ignore malformed/foreign messages in the topic.
          }
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
      if (request.headers.get('x-origin-key') !== env.ORIGIN_UPDATE_KEY) {
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
      if (
        candidate.protocol !== 'https:' ||
        !candidate.hostname.endsWith('.trycloudflare.com') ||
        candidate.pathname !== '/' ||
        candidate.search ||
        candidate.hash
      ) {
        return json({ ok: false, error: 'origin must be a trycloudflare origin' }, 400);
      }
      await env.COMPASS_ORIGIN.put('url', candidate.toString());
      originCache = { url: candidate.toString(), readAt: Date.now() };
      return json({ ok: true, url: candidate.toString() });
    }

    const origin = new URL(await currentOrigin(env));
    const target = new URL(incoming.pathname + incoming.search, origin);

    const headers = new Headers(request.headers);
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

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  },
};
