/**
 * Telegram Bot API relay — runs on Cloudflare Workers.
 *
 * Why this exists: the production server is behind a regional egress
 * policy that blocks api.telegram.org (see the bot delivery notes in
 * apps/worker/src/main.ts). Cloudflare Workers can reach Telegram from
 * any region, so the worker POSTs here and we forward to the real Bot API.
 *
 * Deploy with wrangler from this folder (wrangler.toml); the steps, the
 * secrets and the server settings are in ../README.md.
 *
 * Security (review OPS-27, 2026-11-11):
 *   - The shared-secret header (`x-compass-key`) gates every request. It is
 *     compared in constant time, as in app-proxy (CA-12).
 *   - `method` must be in ALLOWED_METHODS: only what the server calls.
 *     setWebhook, for one, would let anyone holding the key point the bot's
 *     webhook at their own host and read what users send to the bot.
 *   - BOT_TOKEN is never accepted from the caller — it only lives in Worker env.
 */

/**
 * The Bot API methods the server calls through the relay. Today only the
 * outbox's sendMessage (apps/worker/src/main.ts, sendViaRelay); add a
 * method here when the server starts calling it.
 */
const ALLOWED_METHODS = new Set(['sendMessage']);

const encoder = new TextEncoder();

/**
 * Constant-time string comparison, as app-proxy's (CA-12). Length is not
 * secret; the content is compared without an early exit so response timing
 * does not reveal how much of a guessed key was right.
 */
function timingSafeEqual(a, b) {
  const x = encoder.encode(String(a ?? ''));
  const y = encoder.encode(String(b ?? ''));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i += 1) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export default {
  async fetch(req, env) {
    if (req.method !== 'POST') {
      return new Response('use POST', { status: 405 });
    }
    const auth = req.headers.get('x-compass-key');
    if (!env.COMPASS_RELAY_KEY || !timingSafeEqual(auth, env.COMPASS_RELAY_KEY)) {
      return new Response('forbidden', { status: 403 });
    }
    if (!env.BOT_TOKEN) {
      return new Response('worker misconfigured: BOT_TOKEN unset', { status: 500 });
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return new Response('invalid json', { status: 400 });
    }

    const method = String(body?.method ?? '');
    if (!ALLOWED_METHODS.has(method)) {
      return new Response(`method not allowed: ${method}`, { status: 400 });
    }

    const tgRes = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body.params ?? {}),
    });

    return new Response(await tgRes.text(), {
      status: tgRes.status,
      headers: { 'content-type': 'application/json' },
    });
  },
};
