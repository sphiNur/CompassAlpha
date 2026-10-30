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

# 2026-10-30: say so in the journal, in one greppable line, whenever the
# run fails — `set -e` alone exits silently on the failing command, and
# "no backup today" then looks like a quiet success to anyone reading
# `journalctl -u compass-backup` (alerting on it needs the owner's choice
# of channel: see docs/RUNBOOK.md "Backups").
trap 'rc=$?; echo "[backup] FAILED (exit $rc) at line $LINENO: $BASH_COMMAND" >&2' ERR

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

# 2026-07-30: dump as BACKUP_DATABASE_URL when it is set, not as the app
# role.
#
# The app role (`compass`) is deliberately NOT BYPASSRLS — deploy.ts has a
# hard gate (step 4a-pg) that aborts the deploy if it ever becomes so,
# because multi-tenant isolation rests on it. But pg_dump run as an
# RLS-constrained role cannot produce a complete dump; postgres refuses
# the COPY outright rather than silently emitting a partial table:
#
#   ERROR: query would be affected by row-level security policy for
#          table "member_permission_overrides"
#
# So this script could never have worked as written, and had in fact
# never produced a single backup file. The fix is a purpose-built role —
# `compass_backup`: LOGIN + BYPASSRLS + SELECT-only — rather than
# loosening the app role or dumping as the superuser. Set
# BACKUP_DATABASE_URL in the server .env to that role's connection string.
#
# The fallback keeps the script working on a box that has no dedicated
# role yet (a dev machine with RLS effectively unused), where the app
# role can still dump fine.
BACKUP_DATABASE_URL=$(grep -E '^BACKUP_DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | sed 's/^"\(.*\)"$/\1/' || true)
DUMP_URL="${BACKUP_DATABASE_URL:-$DATABASE_URL}"
if [[ -n "${BACKUP_DATABASE_URL:-}" ]]; then
  echo "[backup] using dedicated backup role from BACKUP_DATABASE_URL"
else
  echo "[backup] WARNING: BACKUP_DATABASE_URL unset — dumping as the app role." >&2
  echo "[backup]          If that role is subject to RLS, pg_dump will refuse." >&2
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
  "$DUMP_URL"

ELAPSED=$(( $(date +%s) - START ))
SIZE=$(wc -c < "$DUMP" | tr -d ' ')
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
# 2026-10-30: once BACKUP_S3_BUCKET is set, a missing CLI or a failed
# upload fails the run (exit 1). Both used to log WARN and exit 0, so the
# off-site copy could stop for weeks with the unit reporting success. The
# local dump is kept either way.
if [[ -n "${BACKUP_S3_BUCKET:-}" ]]; then
  if ! command -v aws > /dev/null 2>&1; then
    echo "[backup] ERROR: BACKUP_S3_BUCKET is set but the 'aws' CLI is not installed — no off-site copy (local dump kept: $DUMP)" >&2
    exit 1
  else
    PREFIX="${BACKUP_S3_PREFIX:-compass-backups}"
    REMOTE="s3://${BACKUP_S3_BUCKET}/${PREFIX%/}/compass-${TS}.dump"
    EXTRA_ARGS=()
    if [[ -n "${BACKUP_S3_ENDPOINT:-}" ]]; then
      EXTRA_ARGS+=("--endpoint-url" "$BACKUP_S3_ENDPOINT")
    fi
    echo "[backup] uploading to $REMOTE"
    if aws ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"} s3 cp "$DUMP" "$REMOTE" --only-show-errors; then
      echo "[backup] uploaded"
    else
      # The local copy is still on disk; the next run uploads its own
      # dump (earlier ones are not retried — copy them by hand).
      echo "[backup] ERROR: S3 upload failed — no off-site copy (local dump kept: $DUMP)" >&2
      exit 1
    fi
  fi
fi

echo "[backup] done"
