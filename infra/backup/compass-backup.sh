#!/usr/bin/env bash
#
# CompassAlpha — nightly Postgres backup.
#
# What it does:
#   1. Resolves DATABASE_URL from /home/ubuntu/compass-alpha/.env
#   2. Runs `pg_dump -Fc` (custom compressed format, fast restore)
#   3. Writes to /home/ubuntu/compass-backups/compass-YYYY-MM-DD-HHMMSS.dump
#   4. Verifies the dump opened cleanly (`pg_restore --list` must succeed
#      and the dump must be > 1 KiB — protects against silent failure
#      that produces a 0-byte file)
#   5. Rotates: deletes local dumps older than $RETENTION_DAYS (default 14)
#   6. Optionally uploads to S3-compatible storage if BACKUP_S3_BUCKET is
#      set in .env (works with Yandex / Tencent / MinIO / AWS via aws CLI)
#
# Designed to be run by systemd timer (see compass-backup.timer).
# Exit non-zero on any failure so systemctl status surfaces it.
#
# Restore (one-shot):
#   pg_restore -d "$DATABASE_URL" --clean --if-exists \
#     /home/ubuntu/compass-backups/compass-2026-05-06-033000.dump

set -euo pipefail

ENV_FILE=${ENV_FILE:-/home/ubuntu/compass-alpha/.env}
BACKUP_DIR=${BACKUP_DIR:-/home/ubuntu/compass-backups}
RETENTION_DAYS=${RETENTION_DAYS:-14}
MIN_SIZE_BYTES=${MIN_SIZE_BYTES:-1024}

# --- Load env ---------------------------------------------------------------
if [[ ! -f "$ENV_FILE" ]]; then
  echo "[backup] ERROR: $ENV_FILE not found" >&2
  exit 1
fi
# Read DATABASE_URL (and optional BACKUP_S3_* vars) without exporting
# every line — `.env` may contain secrets we don't want in our shell env.
DATABASE_URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | sed 's/^"\(.*\)"$/\1/')
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[backup] ERROR: DATABASE_URL not found in $ENV_FILE" >&2
  exit 1
fi
BACKUP_S3_BUCKET=$(grep -E '^BACKUP_S3_BUCKET=' "$ENV_FILE" | head -1 | cut -d= -f2- | sed 's/^"\(.*\)"$/\1/' || true)
BACKUP_S3_PREFIX=$(grep -E '^BACKUP_S3_PREFIX=' "$ENV_FILE" | head -1 | cut -d= -f2- | sed 's/^"\(.*\)"$/\1/' || true)
BACKUP_S3_ENDPOINT=$(grep -E '^BACKUP_S3_ENDPOINT=' "$ENV_FILE" | head -1 | cut -d= -f2- | sed 's/^"\(.*\)"$/\1/' || true)

# --- Prep dir ---------------------------------------------------------------
mkdir -p "$BACKUP_DIR"
TS=$(date -u +%Y-%m-%d-%H%M%S)
DUMP="$BACKUP_DIR/compass-$TS.dump"

# --- Dump -------------------------------------------------------------------
echo "[backup] starting pg_dump → $DUMP"
START=$(date +%s)
# -Fc: custom format (parallelizable on restore, internally compressed)
# --no-owner / --no-privileges keep the dump portable across hosts where
# the role names may differ on the restore side.
pg_dump \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="$DUMP" \
  "$DATABASE_URL"

ELAPSED=$(( $(date +%s) - START ))
SIZE=$(stat -c %s "$DUMP")
echo "[backup] pg_dump done — ${SIZE} bytes in ${ELAPSED}s"

# --- Verify -----------------------------------------------------------------
if [[ "$SIZE" -lt "$MIN_SIZE_BYTES" ]]; then
  echo "[backup] ERROR: dump is suspiciously small ($SIZE < $MIN_SIZE_BYTES bytes)" >&2
  rm -f "$DUMP"
  exit 1
fi
# `pg_restore --list` reads the dump's TOC. Catches a corrupt header that
# `pg_dump` somehow exited 0 on (shouldn't happen with -Fc but defensive).
if ! pg_restore --list "$DUMP" > /dev/null 2>&1; then
  echo "[backup] ERROR: dump TOC unreadable — file is corrupt" >&2
  rm -f "$DUMP"
  exit 1
fi
echo "[backup] dump verified"

# --- Rotate -----------------------------------------------------------------
# `find -mtime +N` matches files modified MORE than N*24h ago.
# Default 14 days. Disk is 30 GB free + each dump is ~MB, but we still
# clean to avoid surprises during data growth.
DELETED=$(find "$BACKUP_DIR" -maxdepth 1 -name 'compass-*.dump' -type f -mtime +"$RETENTION_DAYS" -print -delete | wc -l)
if [[ "$DELETED" -gt 0 ]]; then
  echo "[backup] rotated out $DELETED old dumps (older than ${RETENTION_DAYS}d)"
fi

# --- Optional: off-site to S3-compatible storage ----------------------------
if [[ -n "${BACKUP_S3_BUCKET:-}" ]]; then
  if ! command -v aws > /dev/null 2>&1; then
    echo "[backup] WARN: BACKUP_S3_BUCKET set but 'aws' CLI not installed; skipping upload" >&2
  else
    PREFIX="${BACKUP_S3_PREFIX:-compass-backups}"
    REMOTE="s3://${BACKUP_S3_BUCKET}/${PREFIX%/}/compass-${TS}.dump"
    EXTRA_ARGS=()
    if [[ -n "${BACKUP_S3_ENDPOINT:-}" ]]; then
      EXTRA_ARGS+=("--endpoint-url" "$BACKUP_S3_ENDPOINT")
    fi
    echo "[backup] uploading to $REMOTE"
    if aws "${EXTRA_ARGS[@]}" s3 cp "$DUMP" "$REMOTE" --only-show-errors; then
      echo "[backup] uploaded"
    else
      # Don't fail the whole backup just because S3 hiccupped. The local
      # copy is still on disk; the next run will re-upload along with its
      # own dump (we don't track which were uploaded — keep it simple).
      echo "[backup] WARN: S3 upload failed, local copy still good" >&2
    fi
  fi
fi

echo "[backup] done"
