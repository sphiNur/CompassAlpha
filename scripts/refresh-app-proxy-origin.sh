#!/usr/bin/env bash
#
# Manual fallback: publish the current quick-tunnel hostname to the
# Worker's KV fallback. The normal path is automatic via
# compass-origin-watch.timer (ntfy rendezvous, checked every minute).
#
# Required:
#   COMPASS_DEPLOY_HOST=ubuntu@<server-ip>
#   COMPASS_DEPLOY_KEY (optional; defaults to ~/.ssh/compass_alpha_ed25519)
#
set -euo pipefail

: "${COMPASS_DEPLOY_HOST:?set COMPASS_DEPLOY_HOST first}"
deploy_key="${COMPASS_DEPLOY_KEY:-$HOME/.ssh/compass_alpha_ed25519}"
proxy_url="https://compass-alpha.sphinxr.workers.dev"

origin_url="$(
  ssh -i "$deploy_key" -o BatchMode=yes "$COMPASS_DEPLOY_HOST" \
    "grep -oE 'https://[a-z0-9-]+\\.trycloudflare\\.com' /home/ubuntu/compass-tunnel.log | tail -1"
)"

if [[ -z "$origin_url" ]]; then
  echo "No quick-tunnel URL found in /home/ubuntu/compass-tunnel.log" >&2
  exit 1
fi

update_key="$(
  ssh -i "$deploy_key" -o BatchMode=yes "$COMPASS_DEPLOY_HOST" \
    "cat /home/ubuntu/.config/compass-origin.key"
)"
if [[ -z "$update_key" ]]; then
  echo "No Worker update key found on the server" >&2
  exit 1
fi

curl -fsS --max-time 20 \
  -X POST \
  -H "x-origin-key: ${update_key}" \
  -H 'content-type: application/json' \
  --data "{\"url\":\"${origin_url}\"}" \
  "${proxy_url}/__origin"
echo
echo "Stable public entry: ${proxy_url}"
