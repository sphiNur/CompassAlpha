#!/usr/bin/env bash
#
# Refresh the stable workers.dev proxy after the server's quick tunnel
# restarts with a new trycloudflare hostname.
#
# Required:
#   COMPASS_DEPLOY_HOST=ubuntu@<server-ip>
#   COMPASS_DEPLOY_KEY (optional; defaults to ~/.ssh/compass_alpha_ed25519)
#   WRANGLER_BIN (optional; defaults to `wrangler`)
#
set -euo pipefail

: "${COMPASS_DEPLOY_HOST:?set COMPASS_DEPLOY_HOST first}"
deploy_key="${COMPASS_DEPLOY_KEY:-$HOME/.ssh/compass_alpha_ed25519}"
wrangler_bin="${WRANGLER_BIN:-wrangler}"

origin_url="$(
  ssh -i "$deploy_key" -o BatchMode=yes "$COMPASS_DEPLOY_HOST" \
    "grep -oE 'https://[a-z0-9-]+\\.trycloudflare\\.com' /home/ubuntu/compass-tunnel.log | tail -1"
)"

if [[ -z "$origin_url" ]]; then
  echo "No quick-tunnel URL found in /home/ubuntu/compass-tunnel.log" >&2
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root/infra/cloudflare/app-proxy"

"$wrangler_bin" deploy --var "ORIGIN_URL:$origin_url"
echo "Stable public entry: https://compass-alpha.sphinxr.workers.dev"
