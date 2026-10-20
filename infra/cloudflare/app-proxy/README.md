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
