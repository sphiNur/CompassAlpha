#!/usr/bin/env bash
#
# Manual fallback: hand the Worker the current quick-tunnel origin when the
# ntfy rendezvous is down. The normal path is automatic
# (compass-origin-watch.timer, every minute).
#
# Review OPS-15 (2026-11-10): the server signs the message with its own key
# (`compass-origin-watch --print-signed`) and this machine only forwards it
# to /__origin, which checks it like a topic message. No key leaves the
# server; this script used to send the signing key as a header.
#
# Required:
#   COMPASS_DEPLOY_HOST=ubuntu@<server-ip>
#   COMPASS_DEPLOY_KEY  (optional; the same default as scripts/deploy.ts)
#   COMPASS_BASE        (optional; the Worker, default the workers.dev URL)
#
set -euo pipefail

: "${COMPASS_DEPLOY_HOST:?set COMPASS_DEPLOY_HOST first}"
deploy_key="${COMPASS_DEPLOY_KEY:-$HOME/.ssh/compass_alpha.pem}"
proxy_url="${COMPASS_BASE:-https://compass-alpha.sphinxr.workers.dev}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The host key is pinned as in scripts/deploy.ts (sshOptions).
message="$(
  ssh -i "$deploy_key" \
    -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile="$repo/infra/deploy/known_hosts" \
    -o GlobalKnownHostsFile=/dev/null \
    -o BatchMode=yes \
    -o ConnectTimeout=20 \
    "$COMPASS_DEPLOY_HOST" \
    '/usr/local/bin/compass-origin-watch --print-signed'
)"

if [[ ! "$message" =~ ^https://[a-z0-9-]+\.trycloudflare\.com[|][0-9]+[|][0-9a-f]{64}$ ]]; then
  echo "The server did not return a signed origin message: ${message}" >&2
  exit 1
fi

curl -fsS --max-time 20 \
  -X POST \
  -H 'content-type: text/plain' \
  --data-binary "$message" \
  "${proxy_url}/__origin"
echo
echo "Stable public entry: ${proxy_url}"
