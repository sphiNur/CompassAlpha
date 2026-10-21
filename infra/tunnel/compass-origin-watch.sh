#!/usr/bin/env bash
#
# Publish the current quick-tunnel hostname to the stable Workers proxy.
# Runs every minute from compass-origin-watch.timer. If nothing changed,
# it exits without a network call.
#
set -euo pipefail
umask 077

tunnel_log="/home/ubuntu/compass-tunnel.log"
topic_file="/home/ubuntu/.config/compass-origin.topic"
# 2026-10-21 audit CA-12: HMAC key shared with the app-proxy Worker's
# ORIGIN_SIGNING_KEY secret. Lives next to the topic file (mode 600);
# ORIGIN_SIGNING_KEY in the environment overrides it. Without a key the
# script publishes the bare URL exactly as before.
key_file="/home/ubuntu/.config/compass-origin.key"
state_file="/home/ubuntu/.config/compass-origin.last"
publish_file="/home/ubuntu/.config/compass-origin.last-publish"
republish_after_seconds=21600

origin="$(
  grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$tunnel_log" 2>/dev/null |
    tail -1 ||
    true
)"
if [[ -z "$origin" ]]; then
  echo "origin watch: tunnel URL not found yet"
  exit 0
fi

signing_key="${ORIGIN_SIGNING_KEY:-}"
if [[ -z "$signing_key" && -r "$key_file" ]]; then
  signing_key="$(tr -d '\r\n' < "$key_file")"
fi

# The state records whether the last publish was signed, so adding (or
# removing) the key republishes at once instead of up to 6 h later --
# a Worker that already holds the secret ignores the old unsigned
# message in the meantime.
state_value="$origin"
if [[ -n "$signing_key" ]]; then
  state_value="${origin} signed"
fi

last="$(cat "$state_file" 2>/dev/null || true)"
last_publish="$(cat "$publish_file" 2>/dev/null || echo 0)"
now="$(date +%s)"
if [[ "$state_value" == "$last" ]] && ((now - last_publish < republish_after_seconds)); then
  exit 0
fi

topic="$(tr -d '\r\n' < "$topic_file")"
if [[ -z "$topic" ]]; then
  echo "origin watch: ntfy topic is empty" >&2
  exit 1
fi

payload="$origin"
if [[ -n "$signing_key" ]]; then
  # <url>|<unix_ts>|<hex HMAC-SHA256(key, "<url>|<unix_ts>")>. The key
  # is handed over in the environment of this one process, never on a
  # command line where `ps` would show it.
  signature="$(
    ORIGIN_HMAC_KEY="$signing_key" ORIGIN_HMAC_MSG="${origin}|${now}" python3 -I -c '
import hashlib, hmac, os
print(hmac.new(os.environb[b"ORIGIN_HMAC_KEY"], os.environb[b"ORIGIN_HMAC_MSG"], hashlib.sha256).hexdigest())
'
  )"
  if [[ ! "$signature" =~ ^[0-9a-f]{64}$ ]]; then
    echo "origin watch: could not sign the origin update" >&2
    exit 1
  fi
  payload="${origin}|${now}|${signature}"
else
  echo "origin watch: no signing key (${key_file}); publishing unsigned" >&2
fi

response="$(
  curl -fsS --max-time 15 \
    -H 'X-Cache: yes' \
    --data "$payload" \
    "https://ntfy.sh/${topic}"
)"
if [[ "$response" != *'"id"'* ]]; then
  echo "origin watch: ntfy rejected the origin update: $response" >&2
  exit 1
fi

# Confirm the rendezvous itself took the message. The Worker is outside
# the server's egress allow-list, so this is the reachable health check.
for _ in $(seq 1 3); do
  seen="$(
    curl -fsS --max-time 10 \
      "https://ntfy.sh/${topic}/json?poll=1&since=all" 2>/dev/null ||
      true
  )"
  if [[ "$seen" == *"\"message\":\"${payload}\""* ]]; then
    printf '%s\n' "$state_value" > "$state_file"
    printf '%s\n' "$now" > "$publish_file"
    echo "origin watch: published ${origin}${signing_key:+ (signed)}"
    exit 0
  fi
  sleep 2
done

echo "origin watch: ntfy publish could not be read back" >&2
exit 1
