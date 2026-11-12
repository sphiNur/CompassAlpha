#!/usr/bin/env bash
#
# CompassAlpha — one-time installer for the nightly Postgres backup.
#
# What it does (idempotent — safe to re-run):
#   1. Symlinks compass-backup.service + compass-backup.timer into
#      /etc/systemd/system/  (symlinks so future code updates are picked
#      up by `systemctl daemon-reload` without re-copying)
#   2. chmod +x on compass-backup.sh in case git lost the bit
#   3. Creates /home/ubuntu/compass-backups (the destination dir)
#   4. systemctl daemon-reload
#   5. Enables + starts the .timer (NOT the service — the timer fires it)
#   6. Grants the backup role (BACKUP_DATABASE_URL in .env) SELECT on every
#      table and sequence, and on the ones later migrations create
#      (grant-backup-role.sql)
#   7. Optionally runs the first backup immediately so we know it works
#      (skip with INSTALL_SKIP_FIRST_RUN=1)
#
# Run on the server:
#   sudo bash /home/ubuntu/compass-alpha/infra/backup/install.sh
#
# Verify after install:
#   systemctl status compass-backup.timer
#   systemctl list-timers compass-backup.timer
#   journalctl -u compass-backup.service -n 50 --no-pager
#   ls -lh /home/ubuntu/compass-backups/

set -euo pipefail

BACKUP_DIR_DEFAULT=/home/ubuntu/compass-backups
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_SRC="$HERE/compass-backup.service"
TIMER_SRC="$HERE/compass-backup.timer"
SCRIPT_SRC="$HERE/compass-backup.sh"
# Sourced by the script for its database credentials (F11).
PGURL_SRC="$HERE/pg-url.sh"
# env_get, sourced by the script and by this installer (review OPS-32).
ENVLIB_SRC="$HERE/../lib/env.sh"
SYSTEMD_DIR=/etc/systemd/system

# --- Sanity checks ----------------------------------------------------------
if [[ $EUID -ne 0 ]]; then
  echo "[install] ERROR: must be run as root (use sudo)" >&2
  exit 1
fi

for f in "$SERVICE_SRC" "$TIMER_SRC" "$SCRIPT_SRC" "$PGURL_SRC" "$ENVLIB_SRC"; do
  if [[ ! -f "$f" ]]; then
    echo "[install] ERROR: missing $f" >&2
    exit 1
  fi
done

if ! command -v pg_dump > /dev/null 2>&1; then
  echo "[install] ERROR: pg_dump not found on PATH — install postgresql-client first" >&2
  exit 1
fi

# --- Permissions / dirs -----------------------------------------------------
chmod +x "$SCRIPT_SRC"

# Create backup dir owned by ubuntu (the .service runs as User=ubuntu).
mkdir -p "$BACKUP_DIR_DEFAULT"
chown ubuntu:ubuntu "$BACKUP_DIR_DEFAULT"
chmod 750 "$BACKUP_DIR_DEFAULT"

# --- Backup role privileges (review OPS-02, 2026-11-09) -----------------------
# A GRANT on today's tables does not reach a table a later migration
# creates: every nightly backup failed on one from 2026-08 to 2026-11 and
# nothing said so. grant-backup-role.sql also sets the default privileges
# of the role the migrations connect as. Idempotent.
ENV_FILE=${ENV_FILE:-/home/ubuntu/compass-alpha/.env}
# shellcheck source=../lib/env.sh
. "$ENVLIB_SRC"
# shellcheck source=pg-url.sh
. "$PGURL_SRC"
pg_url_parts "$(env_get BACKUP_DATABASE_URL)"
BACKUP_ROLE=$PG_URL_USER
BACKUP_DB=$PG_URL_DB
OWNER_URL=$(env_get DATABASE_URL_DIRECT)
[[ -n "$OWNER_URL" ]] || OWNER_URL=$(env_get DATABASE_URL)
pg_url_parts "$OWNER_URL"
OWNER_ROLE=$PG_URL_USER
if [[ -n "$BACKUP_ROLE" && -n "$BACKUP_DB" && -n "$OWNER_ROLE" ]]; then
  sudo -u postgres psql -q -d "$BACKUP_DB" -v backup="$BACKUP_ROLE" -v owner="$OWNER_ROLE" \
    -f "$HERE/grant-backup-role.sql"
  echo "[install] $BACKUP_ROLE may read every table in $BACKUP_DB, and what $OWNER_ROLE creates later"
else
  echo "[install] WARN: no BACKUP_DATABASE_URL (or DATABASE_URL) with a user and a database in $ENV_FILE —" >&2
  echo "[install]       backups would run as the app role and fail under row-level security. See .env.example." >&2
fi

# --- Install units ----------------------------------------------------------
# Use symlinks so a future git pull on the source files is picked up
# automatically (just rerun `systemctl daemon-reload`). If a unit already
# exists at the target (e.g. from an earlier copy-style install), replace it.
ln -sfn "$SERVICE_SRC" "$SYSTEMD_DIR/compass-backup.service"
ln -sfn "$TIMER_SRC"   "$SYSTEMD_DIR/compass-backup.timer"

systemctl daemon-reload

# Enable + start the timer (not the service; the timer triggers it).
systemctl enable --now compass-backup.timer

echo "[install] timer installed and enabled"
systemctl list-timers compass-backup.timer --no-pager || true

# --- Optional: trigger an immediate first run so we know it works -----------
if [[ "${INSTALL_SKIP_FIRST_RUN:-0}" != "1" ]]; then
  echo "[install] running first backup now (set INSTALL_SKIP_FIRST_RUN=1 to skip)…"
  if systemctl start compass-backup.service; then
    # `start` on a oneshot returns when the unit finishes (or fails).
    echo "[install] first run complete — recent log lines:"
    journalctl -u compass-backup.service -n 30 --no-pager || true
    echo "[install] backup files now in $BACKUP_DIR_DEFAULT:"
    ls -lh "$BACKUP_DIR_DEFAULT" | tail -n +2 || true
  else
    echo "[install] WARN: first run failed — see: journalctl -u compass-backup.service" >&2
    exit 1
  fi
fi

echo "[install] done"
