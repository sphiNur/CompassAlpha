# Compass app proxy

The production server exposes HTTP but has no fixed HTTPS domain. This
Worker is the stable public HTTPS entry:

```
https://compass-alpha.sphinxr.workers.dev
```

Traffic path:

```
Telegram / browser
  → workers.dev (stable HTTPS)
  → current cloudflared quick-tunnel hostname
  → nginx :80
  → Compass API :3000
```

The stable Worker reads the current origin from a private ntfy topic.
`compass-origin-watch.timer` runs on the server every minute, detects a
new tunnel hostname, publishes it, and verifies the publication. No
manual action is needed when the tunnel or server restarts.

### Signed origin messages (CA-12, 2026-10-21)

The ntfy topic is reachable by anyone who learns its name. With the
`ORIGIN_SIGNING_KEY` Worker secret set, the Worker only accepts messages
of the form `<url>|<unix_ts>|<hex sig>`, where
`sig = HMAC-SHA256(key, "<url>|<unix_ts>")`, the timestamp is at most 7
days old and at most 5 minutes in the future, and the signature compares
in constant time. Without the secret it accepts unsigned (and signed)
messages as before and logs one warning per isolate. The `/__origin` key
check is constant-time too.

The watchdog signs when it finds a key in
`/home/ubuntu/.config/compass-origin.key` (mode 600, next to the topic
file) or in `ORIGIN_SIGNING_KEY`. Rollout, server first so the Worker never
waits on an unsigned message it would reject:

1. `openssl rand -hex 32` → write it to the key file on the server.
2. `sudo systemctl start compass-origin-watch.service` — publishes a
   signed message immediately (the state file records signed/unsigned,
   so a mode change always republishes).
3. `wrangler secret put ORIGIN_SIGNING_KEY` with the same value.

Revert with `wrangler secret delete ORIGIN_SIGNING_KEY`. See
docs/RUNBOOK.md "Sign the origin rendezvous".

### Real client address for rate limiting (AUTH-6, 2026-10-30)

On the tunnel hop the API cannot see who is calling: `cf-connecting-ip`
there names the Worker, and `x-forwarded-for` is whatever the client
sent. With the `CLIENT_IP_PROXY_KEY` secret set, the Worker forwards
the real client address (Cloudflare's `cf-connecting-ip` as the Worker
receives it) in `x-compass-client-ip`, together with the secret in
`x-compass-proxy-key`; it always drops client-sent copies of both.

Rollout, Worker first so the API never waits on a header it would require:

1. `openssl rand -hex 32`.
2. `wrangler secret put CLIENT_IP_PROXY_KEY` with that value, then
   `wrangler deploy` (this worker.js).
3. Add `CLIENT_IP_PROXY_KEY=<same value>` to the server `.env` and
   restart the API.

Until step 3 the API keeps using `cf-connecting-ip` as before (never
`x-forwarded-for`). After it, a request without the right key (one
that skipped the Worker) has no trusted address and shares a single
rate-limit bucket. Revert with step 3 undone (remove the line, restart).

The Worker is deployed with:

```bash
wrangler deploy
```

The quick tunnel is supervised by `compass-app-tunnel.service` and logs
its current hostname to `/home/ubuntu/compass-tunnel.log`.

Manual fallback (only if the watchdog or ntfy is unavailable) writes the
current origin into the Worker's KV fallback:

```bash
COMPASS_DEPLOY_HOST=ubuntu@129.204.59.183 \
COMPASS_DEPLOY_KEY=$HOME/.ssh/compass_alpha_ed25519 \
bash scripts/refresh-app-proxy-origin.sh
```

The server's `FRONTEND_URL` must remain the workers.dev URL so invite
fallbacks, notifications and CORS all point at the stable entry.
