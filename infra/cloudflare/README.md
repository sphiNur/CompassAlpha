# Cloudflare infrastructure

## `tg-relay/` — Telegram Bot API relay

The production server cannot reach `api.telegram.org` directly (regional
egress policy — see [`apps/worker/src/main.ts`](../../apps/worker/src/main.ts)
for the kill-switch context). This Worker forwards bot-API calls from
the server to Telegram via Cloudflare's global network.

### Deploy

From [`tg-relay/`](./tg-relay/), with wrangler logged in to the account:

```bash
cd infra/cloudflare/tg-relay
wrangler deploy
```

- [`wrangler.toml`](./tg-relay/wrangler.toml) names the Worker `tg-relay`.
  That must be the name it already has in the dashboard: under another
  name wrangler creates a second Worker, with a new URL and no secrets.
- The secrets stay on the Worker from one deploy to the next. To set them
  the first time, or to rotate them:
  ```bash
  wrangler secret put BOT_TOKEN           # the BotFather token (123456:ABC-DEF...)
  wrangler secret put COMPASS_RELAY_KEY   # 32+ random bytes, hex
  ```
  Generate the key with `openssl rand -hex 32` (PowerShell:
  `-join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })`).
- The public URL looks like `https://tg-relay.<your-account>.workers.dev`.

Until 2026-11 the Worker was deployed by pasting the file into the
dashboard, so nothing showed whether the live code matched the repo
(review OPS-27). A `wrangler deploy` from this folder ships the repo's
[`worker.js`](./tg-relay/worker.js).

### Wire the server

Add to the production `.env` on the compass server:

```
TG_RELAY_URL=https://tg-relay.<your-account>.workers.dev
COMPASS_RELAY_KEY=<the same hex value you set on the Worker>
BOT_DELIVERY_ENABLED=true
```

Then restart the worker process:

```bash
sudo systemctl restart compass-worker
journalctl -u compass-worker -f   # watch for "bot delivery sent" lines
```

### Verify end-to-end

```bash
# 1) Direct relay smoke
curl -X POST $TG_RELAY_URL \
  -H "x-compass-key: $COMPASS_RELAY_KEY" \
  -H "content-type: application/json" \
  -d '{"method":"sendMessage","params":{"chat_id":<your tg user id>,"text":"hello compass"}}'
# Expect: HTTP 200 and a Bot API JSON body. Your Telegram receives "hello compass".

# 2) End-to-end through the outbox
# Submit an order in the mini app as a staff user.
# The approver(s) should receive a Telegram push within a few seconds.
```

### Security notes

- The Worker accepts requests only from callers presenting the right
  `x-compass-key` header — anyone discovering the public URL still
  cannot send messages without the shared secret. The header is compared
  in constant time, as in app-proxy.
- `method` must be one the server calls: only `sendMessage` today
  (`ALLOWED_METHODS` in `worker.js`). With `setWebhook` allowed, anyone
  holding the key could point the bot's webhook at their own host and
  read what users send to the bot. Add a method there when the server
  starts calling it.
- `BOT_TOKEN` is held server-side only on the Worker; the compass
  server never sees it (and does not need to).
- If `COMPASS_RELAY_KEY` ever leaks, rotate it on the Worker first,
  then on the server `.env`, then restart the worker — relay calls
  will 403 in the meantime, the outbox will defer with backoff, and
  no messages get lost.

### Future hardening

- Add per-chat rate limit in the Worker (Cloudflare KV counter) if
  abuse becomes a concern.
- Pin the Worker to a region close to the server's egress to keep
  added latency under ~50ms.
