#!/usr/bin/env bash
#
# CompassAlpha — disaster-recovery restore helper.
#
# DESTRUCTIVE: this drops + recreates objects in the target database.
# Use only when you actually want to overwrite the target DB with a dump.
#
# Usage:
#   # Interactive — pick from list of dumps in BACKUP_DIR
#   sudo -u ubuntu bash /home/ubuntu/compass-alpha/infra/backup/restore.sh
#
#   # Non-interactive — restore a specific dump
#   sudo -u ubuntu bash /home/ubuntu/compass-alpha/infra/backup/restore.sh \
#     /home/ubuntu/compass-backups/compass-2026-05-04-033000.dump
#
#   # Restore into a different DB than .env's DATABASE_URL
#   DATABASE_URL=postgresql://… bash restore.sh <dump>
#
# What it does:
#   1. Resolves DATABASE_URL (override > .env > error)
#   2. Picks dump file (arg > newest in BACKUP_DIR)
#   3. Verifies the dump opens cleanly (`pg_restore --list`)
#   4. Prints target DB host/db + dump filename and asks for "yes" to proceed
#   5. Runs `pg_restore --clean --if-exists --no-owner --no-privileges`
#      with --single-transaction so a failure rolls back instead of half-
#      restoring.

set -euo pipefail

ENV_FILE=${ENV_FILE:-/home/ubuntu/compass-alpha/.env}
BACKUP_DIR=${BACKUP_DIR:-/home/ubuntu/compass-backups}

# --- Resolve DATABASE_URL ---------------------------------------------------
if [[ -z "${DATABASE_URL:-}" ]]; then
  if [[ -f "$ENV_FILE" ]]; then
    DATABASE_URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | sed 's/^"\(.*\)"$/\1/')
  fi
fi
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[restore] ERROR: DATABASE_URL not set and not found in $ENV_FILE" >&2
  exit 1
fi

# --- Pick dump --------------------------------------------------------------
DUMP="${1:-}"
if [[ -z "$DUMP" ]]; then
  echo "[restore] no dump specified — available dumps in $BACKUP_DIR:"
  mapfile -t DUMPS < <(ls -1t "$BACKUP_DIR"/compass-*.dump 2>/dev/null || true)
  if [[ ${#DUMPS[@]} -eq 0 ]]; then
    echo "[restore] ERROR: no dumps found in $BACKUP_DIR" >&2
    exit 1
  fi
  for i in "${!DUMPS[@]}"; do
    SIZE=$(stat -c %s "${DUMPS[$i]}" 2>/dev/null || echo 0)
    SIZE_HUMAN=$(numfmt --to=iec --suffix=B "$SIZE" 2>/dev/null || echo "${SIZE}B")
    printf '  [%2d] %s  (%s)\n' "$i" "${DUMPS[$i]}" "$SIZE_HUMAN"
  done
  read -rp "Enter index to restore (0 = newest), or full path: " PICK
  if [[ "$PICK" =~ ^[0-9]+$ ]]; then
    DUMP="${DUMPS[$PICK]:-}"
  else
    DUMP="$PICK"
  fi
fi

if [[ -z "$DUMP" || ! -f "$DUMP" ]]; then
  echo "[restore] ERROR: dump not found: $DUMP" >&2
  exit 1
fi

# --- Verify dump readable ---------------------------------------------------
if ! pg_restore --list "$DUMP" > /dev/null 2>&1; then
  echo "[restore] ERROR: $DUMP is corrupt or not a pg_dump custom-format file" >&2
  exit 1
fi

# --- Confirm ----------------------------------------------------------------
# Strip user:pass for display so we don't echo creds to the terminal.
SAFE_URL=$(echo "$DATABASE_URL" | sed -E 's#://[^@]+@#://***@#')
echo
echo "[restore] About to RESTORE:"
echo "[restore]   dump:     $DUMP"
echo "[restore]   target:   $SAFE_URL"
echo "[restore] This will DROP + recreate objects in the target database."
read -rp "[restore] Type 'yes' to proceed: " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
  echo "[restore] aborted"
  exit 1
fi

# --- Restore ----------------------------------------------------------------
# --single-transaction: if anything fails, the whole restore rolls back.
# --clean --if-exists: drop target objects before recreating, but don't
#   error if they don't exist yet.
# --no-owner --no-privileges: matches how we dumped — keeps it portable.
echo "[restore] starting pg_restore…"
START=$(date +%s)
pg_restore \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --single-transaction \
  --dbname="$DATABASE_URL" \
  "$DUMP"
ELAPSED=$(( $(date +%s) - START ))
echo "[restore] done in ${ELAPSED}s"
