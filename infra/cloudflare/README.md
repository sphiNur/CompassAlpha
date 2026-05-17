# Cloudflare infrastructure

## `tg-relay.js` — Telegram Bot API relay

The production server cannot reach `api.telegram.org` directly (regional
egress policy — see [`apps/worker/src/main.ts`](../../apps/worker/src/main.ts)
for the kill-switch context). This Worker forwards bot-API calls from
the server to Telegram via Cloudflare's global network.

### Deploy

1. **Cloudflare dashboard → Workers & Pages → Create Worker.** Replace
   the template code with the contents of [`tg-relay.js`](./tg-relay.js).
2. **Settings → Variables and Secrets** → add as **encrypted secrets**
   (NOT plain environment variables):
   - `BOT_TOKEN` — the BotFather token (e.g. `123456:ABC-DEF...`).
   - `COMPASS_RELAY_KEY` — 32+ random bytes hex. Generate with:
     ```bash
     openssl rand -hex 32                   # linux/mac
     # or in PowerShell:
     -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
     ```
3. **Deploy.** Note the public URL — looks like
   `https://tg-relay.<your-account>.workers.dev`.

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
  cannot send messages without the shared secret.
- `method` is whitelisted to a known set of Bot API verbs so the relay
  cannot be abused to probe arbitrary URLs even with the key.
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
