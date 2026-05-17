/**
 * Telegram Bot API relay — runs on Cloudflare Workers.
 *
 * Why this exists: the production server is behind a regional egress
 * policy that blocks api.telegram.org (see apps/worker/src/main.ts:60).
 * Cloudflare Workers can reach Telegram from any region, so the worker
 * POSTs here and we forward to the real Bot API.
 *
 * Deploy:
 *   1. Cloudflare dashboard → Workers & Pages → Create → "Hello World"
 *      template. Replace the worker code with this file.
 *   2. Settings → Variables and Secrets → add (as encrypted secrets):
 *        - BOT_TOKEN       (the BotFather token, e.g. 123:ABC...)
 *        - COMPASS_RELAY_KEY (32+ random bytes hex; generate with
 *                             `openssl rand -hex 32` or
 *                             `[guid]::NewGuid().Guid + [guid]::NewGuid().Guid`)
 *   3. Deploy. Note the worker URL — looks like
 *      https://tg-relay.<account>.workers.dev
 *   4. On the compass server, set in .env:
 *        TG_RELAY_URL=https://tg-relay.<account>.workers.dev
 *        COMPASS_RELAY_KEY=<same value as above>
 *        BOT_DELIVERY_ENABLED=true
 *      Then `sudo systemctl restart compass-worker`.
 *
 * Verify:
 *   curl -X POST $TG_RELAY_URL \
 *     -H "x-compass-key: $COMPASS_RELAY_KEY" \
 *     -H "content-type: application/json" \
 *     -d '{"method":"sendMessage","params":{"chat_id":<your tg id>,"text":"hello compass"}}'
 *   # Expect: Telegram receives "hello compass", response is the Bot API JSON.
 *
 * Security:
 *   - Shared-secret header (`x-compass-key`) gates every request.
 *   - `method` is whitelisted to [A-Za-z]+ so callers cannot probe arbitrary URLs.
 *   - BOT_TOKEN is never accepted from the caller — it only lives in Worker env.
 */

const ALLOWED_METHODS = new Set([
  'sendMessage',
  'editMessageText',
  'deleteMessage',
  'sendChatAction',
  'answerCallbackQuery',
  'setWebhook',
  'deleteWebhook',
  'getMe',
]);

export default {
  async fetch(req, env) {
    if (req.method !== 'POST') {
      return new Response('use POST', { status: 405 });
    }
    const auth = req.headers.get('x-compass-key');
    if (!env.COMPASS_RELAY_KEY || auth !== env.COMPASS_RELAY_KEY) {
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
