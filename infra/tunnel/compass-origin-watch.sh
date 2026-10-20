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

last="$(cat "$state_file" 2>/dev/null || true)"
last_publish="$(cat "$publish_file" 2>/dev/null || echo 0)"
now="$(date +%s)"
if [[ "$origin" == "$last" ]] && ((now - last_publish < republish_after_seconds)); then
  exit 0
fi

topic="$(tr -d '\r\n' < "$topic_file")"
if [[ -z "$topic" ]]; then
  echo "origin watch: ntfy topic is empty" >&2
  exit 1
fi

response="$(
  curl -fsS --max-time 15 \
    -H 'X-Cache: yes' \
    --data "$origin" \
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
  if [[ "$seen" == *"\"message\":\"${origin}\""* ]]; then
    printf '%s\n' "$origin" > "$state_file"
    printf '%s\n' "$now" > "$publish_file"
    echo "origin watch: published ${origin}"
    exit 0
  fi
  sleep 2
done

echo "origin watch: ntfy publish could not be read back" >&2
exit 1
