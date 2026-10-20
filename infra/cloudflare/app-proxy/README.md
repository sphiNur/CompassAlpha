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
  → cloudflared quick tunnel (origin hostname may change)
  → nginx :80
  → Compass API :3000
```

The Worker is deployed with:

```bash
wrangler deploy
```

The quick tunnel is supervised by `compass-app-tunnel.service` and logs
its current hostname to `/home/ubuntu/compass-tunnel.log`. If that
service or the host restarts, the origin hostname changes. Refresh the
Worker origin without changing the public URL:

```bash
COMPASS_DEPLOY_HOST=ubuntu@129.204.59.183 \
COMPASS_DEPLOY_KEY=$HOME/.ssh/compass_alpha_ed25519 \
WRANGLER_BIN=/path/to/wrangler \
bash scripts/refresh-app-proxy-origin.sh
```

The server's `FRONTEND_URL` must remain the workers.dev URL so invite
fallbacks, notifications and CORS all point at the stable entry.
