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
