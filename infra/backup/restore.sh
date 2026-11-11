#!/usr/bin/env bash
#
# CompassAlpha — restore a nightly dump into a NEW, empty database.
#
# It never restores over a database in use (review OPS-11, 2026-11-10).
# `pg_restore --clean` over the live database failed whenever the role
# did not own every object it had to drop, and whenever the database held
# something newer than the dump (a schema with one more table cannot be
# dropped); either way after a disaster, with nothing to go back to.
# Restore next to the live database, check it, then swap the names:
# docs/RUNBOOK.md, "Restore from a dump".
#
# Usage:
#   RESTORE_DATABASE_URL=postgresql://compass:…@localhost/compass_restored \
#     bash restore.sh [--yes] [<dump>]
#
#   RESTORE_DATABASE_URL  the new database, as the role the migrations run
#                         as (the user in DATABASE_URL_DIRECT). The tables
#                         belong to whoever restores them, and the next
#                         migration must own them.
#   RESTORE_OWNER         needed when that URL's role is a superuser: the
#                         role the tables are restored as (pg_restore
#                         --role). Without it the script refuses, rather
#                         than let a superuser own them.
#   <dump>                a file; without one, pick from BACKUP_DIR.
#   --yes                 no prompt (drills, CI).
#
# Afterwards the backup role (the user in BACKUP_DATABASE_URL in ENV_FILE)
# gets its SELECT again (grant-backup-role.sql): without it the next
# nightly dump fails. An api that connects as a role other than the owner
# (the user in DATABASE_URL) gets nothing back, and the script says so.
# infra/backup/drill.sh rehearses all of this.

set -euo pipefail

# F11: credentials go to pg_restore and psql through PGPASSWORD, not argv.
# shellcheck source=pg-url.sh
source "$(dirname "${BASH_SOURCE[0]}")/pg-url.sh"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ENV_FILE=${ENV_FILE:-/home/ubuntu/compass-alpha/.env}
BACKUP_DIR=${BACKUP_DIR:-/home/ubuntu/compass-backups}
# A value from ENV_FILE without its quotes; empty when it is not there.
env_get() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^"\(.*\)"$/\1/' || true; }

# --- Arguments --------------------------------------------------------------
YES=0
DUMP=""
for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    -*)
      echo "[restore] ERROR: unknown option $arg" >&2
      exit 1
      ;;
    *) DUMP="$arg" ;;
  esac
done

# --- Target -----------------------------------------------------------------
if [[ -z "${RESTORE_DATABASE_URL:-}" ]]; then
  echo "[restore] ERROR: set RESTORE_DATABASE_URL to a new, empty database," >&2
  echo "[restore]        as the role the migrations run as. DATABASE_URL is" >&2
  echo "[restore]        no longer read: it names the live database." >&2
  exit 1
fi
pg_url_split "$RESTORE_DATABASE_URL"
TARGET="$PG_URL_NOPASS"

# --- Pick dump --------------------------------------------------------------
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

# --- Check the target -------------------------------------------------------
# One query: the role, whether it is a superuser, and how many tables,
# views and sequences the database has (an extension's do not count).
CHECK=$(psql "$TARGET" -X -A -t -v ON_ERROR_STOP=1 -c "
  SELECT current_user,
         (SELECT rolsuper FROM pg_roles WHERE rolname = current_user),
         (SELECT count(*) FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
             AND n.nspname <> 'information_schema'
             AND n.nspname NOT LIKE 'pg\_%'
             AND NOT EXISTS (SELECT 1 FROM pg_depend d
                              WHERE d.classid = 'pg_class'::regclass
                                AND d.objid = c.oid AND d.deptype = 'e'))")
IFS='|' read -r ROLE SUPERUSER OBJECTS <<< "$CHECK"
OWNER="${RESTORE_OWNER:-$ROLE}"
if [[ "$SUPERUSER" == "t" && -z "${RESTORE_OWNER:-}" ]]; then
  echo "[restore] ERROR: the role in RESTORE_DATABASE_URL is a superuser, and" >&2
  echo "[restore]        the restored tables would belong to it. Set" >&2
  echo "[restore]        RESTORE_OWNER to the role the migrations run as." >&2
  exit 1
fi
if [[ "$OBJECTS" != "0" ]]; then
  echo "[restore] ERROR: the target database is not empty ($OBJECTS tables," >&2
  echo "[restore]        views or sequences). Restore into a new database and" >&2
  echo "[restore]        swap the names (docs/RUNBOOK.md, \"Restore from a dump\")." >&2
  exit 1
fi

# --- Confirm ----------------------------------------------------------------
# The URL is shown without its password (pg_url_split).
echo
echo "[restore] About to RESTORE:"
echo "[restore]   dump:     $DUMP"
echo "[restore]   target:   $TARGET"
echo "[restore]   owner:    $OWNER"
if [[ "$YES" -ne 1 ]]; then
  read -rp "[restore] Type 'yes' to proceed: " CONFIRM
  if [[ "$CONFIRM" != "yes" ]]; then
    echo "[restore] aborted"
    exit 1
  fi
fi

# --- Restore ----------------------------------------------------------------
# --single-transaction: if anything fails, the whole restore rolls back.
# --no-owner --no-privileges: matches how we dumped; the objects belong to
#   the role that creates them, OWNER (--role sets it after connecting).
echo "[restore] starting pg_restore…"
START=$(date +%s)
pg_restore \
  --no-owner \
  --no-privileges \
  --single-transaction \
  --role="$OWNER" \
  --dbname="$TARGET" \
  "$DUMP"
ELAPSED=$(( $(date +%s) - START ))
echo "[restore] done in ${ELAPSED}s"

# --- The backup role's SELECT -----------------------------------------------
pg_url_parts "$(env_get BACKUP_DATABASE_URL)"
BACKUP_ROLE="$PG_URL_USER"
if [[ -n "$BACKUP_ROLE" ]]; then
  # OWNER owns everything now. It (or the superuser) may grant, and set the
  # default privileges for the tables its migrations create later.
  if ! psql "$TARGET" -X -q -v ON_ERROR_STOP=1 -v backup="$BACKUP_ROLE" -v owner="$OWNER" \
    -f "$HERE/grant-backup-role.sql"; then
    echo "[restore] ERROR: restored, but the backup role $BACKUP_ROLE was not" >&2
    echo "[restore]        given SELECT; run install.sh after the swap." >&2
    exit 1
  fi
  echo "[restore] backup role $BACKUP_ROLE can read the restored database"
else
  echo "[restore] WARNING: no BACKUP_DATABASE_URL in $ENV_FILE — the backup role" >&2
  echo "[restore]          was given nothing; run install.sh after the swap." >&2
fi

# --- The api's role ---------------------------------------------------------
# A dump carries no GRANTs (--no-privileges). The owner needs none; an api
# that connects as another role would find nothing it may read.
pg_url_parts "$(env_get DATABASE_URL)"
if [[ -n "$PG_URL_USER" && "$PG_URL_USER" != "$OWNER" ]]; then
  echo "[restore] WARNING: the api connects as $PG_URL_USER, which owns nothing here," >&2
  echo "[restore]          and a dump carries no GRANTs: give it its grants" >&2
  echo "[restore]          before the api starts on this database." >&2
fi

echo "[restore] next: check it, swap the names, migrate, start, smoke"
echo "[restore]       (docs/RUNBOOK.md, \"Restore from a dump\")."
