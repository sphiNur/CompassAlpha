#!/usr/bin/env bash
#
# CompassAlpha — backup and restore drill (review OPS-11, 2026-11-10).
#
# The nightly script dumps a database set up the way production has it,
# restore.sh puts the dump into a new database, once as the owner and once
# as a superuser with RESTORE_OWNER, and each must match it: every table's
# rows, who owns what, the row-level security, the triggers that keep the
# event store and the daily-close revisions append-only, the sequences.
# Then the next night's dump of the restored database must work, and the
# names are swapped as docs/RUNBOOK.md says. CI runs it on every change
# (.github/workflows/ci.yml, "restore-drill"); run it against any
# Postgres 18 on which you are a superuser:
#
#   DRILL_ADMIN_URL=postgres://compass:compass@localhost:5433/postgres \
#     bash infra/backup/drill.sh
#
# Needs pg_dump, pg_restore and psql of the server's major version, and
# the repository's dependencies (the migrations and the seed run on bun).
#
# Roles, as production has them (the drill makes them if missing):
#   compass_drill_owner   LOGIN, neither superuser nor BYPASSRLS. Owns the
#                         database and runs the migrations.
#   compass_drill_backup  LOGIN BYPASSRLS, SELECT only (grant-backup-role.sql).
# The databases are dropped at the end; the roles stay.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
: "${DRILL_ADMIN_URL:?set DRILL_ADMIN_URL to a superuser connection to the postgres database}"

if [[ ! "$DRILL_ADMIN_URL" =~ ^([A-Za-z][A-Za-z0-9+.-]*)://[^@/]*@([^/?]+) ]]; then
  echo "[drill] ERROR: DRILL_ADMIN_URL must look like postgres://user:password@host:port/postgres" >&2
  exit 1
fi
SCHEME="${BASH_REMATCH[1]}"
HOSTPORT="${BASH_REMATCH[2]}"
# A URL on the same server: url <user> <password> <database>
url() { echo "$SCHEME://$1:$2@$HOSTPORT/$3"; }

OWNER=compass_drill_owner
OWNER_PASSWORD=drill-owner
BACKUP=compass_drill_backup
BACKUP_PASSWORD=drill-backup
# "test" in the names: a bun test run accepts no other database (CLAUDE.md).
SUFFIX="$(date +%s)_$$"
LIVE="compass_drill_test_live_$SUFFIX"
RESTORED="compass_drill_test_restored_$SUFFIX"
BY_ADMIN="compass_drill_test_by_admin_$SUFFIX"
OLD="compass_drill_test_old_$SUFFIX"
WORK="$(mktemp -d)"

admin() { psql "$DRILL_ADMIN_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }
admin_on() {
  local db="$1"
  shift
  psql "${DRILL_ADMIN_URL%/*}/$db" -X -q -v ON_ERROR_STOP=1 "$@"
}

cleanup() {
  local db
  for db in "$LIVE" "$RESTORED" "$BY_ADMIN" "$OLD"; do
    admin -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" > /dev/null 2>&1 || true
  done
  rm -rf -- "$WORK"
}
trap cleanup EXIT
step() { echo; echo "[drill] $*"; }

# --- A database as production has it ---------------------------------------
step "roles and the live database"
admin <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$OWNER') THEN
    CREATE ROLE $OWNER LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$BACKUP') THEN
    CREATE ROLE $BACKUP LOGIN;
  END IF;
END
\$\$;
ALTER ROLE $OWNER LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB PASSWORD '$OWNER_PASSWORD';
ALTER ROLE $BACKUP LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB PASSWORD '$BACKUP_PASSWORD';
CREATE DATABASE "$LIVE" OWNER $OWNER;
SQL

LIVE_OWNER_URL="$(url "$OWNER" "$OWNER_PASSWORD" "$LIVE")"
step "migrate and seed as the owner"
(
  cd "$ROOT"
  DATABASE_URL="$LIVE_OWNER_URL" DATABASE_URL_DIRECT="$LIVE_OWNER_URL" \
    pnpm --silent --filter @compass/db migrate > "$WORK/migrate.log"
  DATABASE_URL="$LIVE_OWNER_URL" DATABASE_URL_DIRECT="$LIVE_OWNER_URL" \
    pnpm --silent --filter @compass/db seed > "$WORK/seed.log"
)

# Rows in the append-only tables too: their triggers refuse UPDATE and
# DELETE, and must come back after the data.
admin_on "$LIVE" <<'SQL'
WITH o AS (SELECT id FROM auth.organizations ORDER BY slug LIMIT 1)
INSERT INTO domain.events (org_id, stream_type, stream_id, seq, type, payload)
SELECT o.id, 'drill', '00000000-0000-4000-8000-000000000001', n, 'drill.step', jsonb_build_object('n', n)
  FROM o, generate_series(1, 3) AS n;
WITH s AS (SELECT id, org_id FROM inventory.stores ORDER BY name LIMIT 1),
     d AS (INSERT INTO inventory.store_daily_settlements (org_id, store_id, settlement_date)
           SELECT org_id, id, DATE '2026-11-01' FROM s RETURNING id, org_id, store_id, settlement_date)
INSERT INTO inventory.store_daily_settlement_revisions
       (settlement_id, org_id, store_id, settlement_date, version, snapshot, actor_member_id)
SELECT id, org_id, store_id, settlement_date, 1, '{}', '00000000-0000-4000-8000-000000000002' FROM d;
SQL

step "the backup role, as install.sh grants it"
admin_on "$LIVE" -v backup="$BACKUP" -v owner="$OWNER" -f "$HERE/grant-backup-role.sql"

# --- The nightly dump --------------------------------------------------------
backup_of() {
  local db="$1" dir="$2"
  printf '%s\n' \
    "DATABASE_URL=$(url "$OWNER" "$OWNER_PASSWORD" "$db")" \
    "BACKUP_DATABASE_URL=$(url "$BACKUP" "$BACKUP_PASSWORD" "$db")" > "$WORK/env"
  ENV_FILE="$WORK/env" BACKUP_DIR="$dir" bash "$HERE/compass-backup.sh"
}
step "the nightly dump, by compass-backup.sh"
backup_of "$LIVE" "$WORK/backups"
DUMP="$(ls -1 "$WORK/backups"/compass-*.dump | head -1)"

# --- Restore -----------------------------------------------------------------
admin -c "CREATE DATABASE \"$RESTORED\" OWNER $OWNER"
RESTORED_OWNER_URL="$(url "$OWNER" "$OWNER_PASSWORD" "$RESTORED")"

refused() {
  local what="$1"
  shift
  if "$@" > "$WORK/refused.log" 2>&1; then
    echo "[drill] FAILED: restore.sh restored $what" >&2
    cat "$WORK/refused.log" >&2
    exit 1
  fi
  echo "[drill] refused, as it should: $what — $(grep -m1 ERROR "$WORK/refused.log")"
}
step "restore.sh refuses a database in use, and a superuser without RESTORE_OWNER"
refused "over the live database" \
  env ENV_FILE="$WORK/env" RESTORE_DATABASE_URL="$LIVE_OWNER_URL" \
  bash "$HERE/restore.sh" --yes "$DUMP"
refused "as a superuser without RESTORE_OWNER" \
  env ENV_FILE="$WORK/env" RESTORE_DATABASE_URL="${DRILL_ADMIN_URL%/*}/$RESTORED" \
  bash "$HERE/restore.sh" --yes "$DUMP"

step "restore into the new database"
START=$(date +%s)
ENV_FILE="$WORK/env" RESTORE_DATABASE_URL="$RESTORED_OWNER_URL" \
  bash "$HERE/restore.sh" --yes "$DUMP"
echo "[drill] restored in $(( $(date +%s) - START ))s"

# Where only a superuser can connect, RESTORE_OWNER names the role the
# tables are restored as.
step "restore as a superuser, with RESTORE_OWNER"
admin -c "CREATE DATABASE \"$BY_ADMIN\" OWNER $OWNER"
ENV_FILE="$WORK/env" RESTORE_OWNER="$OWNER" RESTORE_DATABASE_URL="${DRILL_ADMIN_URL%/*}/$BY_ADMIN" \
  bash "$HERE/restore.sh" --yes "$DUMP"

# --- Compare -----------------------------------------------------------------
# What a database holds, one line each, sorted. Read as the superuser,
# which row-level security does not hide rows from.
snapshot() {
  admin_on "$1" -A -t <<'SQL'
SELECT line FROM (
  SELECT format('rows %s.%s %s', table_schema, table_name,
           (xpath('/row/h/text()', query_to_xml(format(
             'SELECT count(*) || '' '' || md5(coalesce(string_agg(t::text, E''\n'' ORDER BY t::text), '''')) AS h FROM %I.%I t',
             table_schema, table_name), false, true, '')))[1]::text) AS line
    FROM information_schema.tables
   WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')
  UNION ALL
  SELECT format('rls %s.%s enabled=%s forced=%s', n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND n.nspname NOT LIKE 'pg\_%'
  UNION ALL
  -- Who owns what: the next migration runs as the owner and must own it.
  SELECT format('owner %s %s', nspname, pg_get_userbyid(nspowner)) FROM pg_namespace
   WHERE nspname <> 'information_schema' AND nspname NOT LIKE 'pg\_%'
  UNION ALL
  SELECT format('owner %s.%s %s', n.nspname, c.relname, pg_get_userbyid(c.relowner))
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') AND n.nspname <> 'information_schema'
     AND n.nspname NOT LIKE 'pg\_%'
  UNION ALL
  SELECT format('policy %s.%s %s %s %s', schemaname, tablename, policyname, cmd, qual) FROM pg_policies
  UNION ALL
  SELECT format('trigger %s.%s %s', event_object_schema, event_object_table, trigger_name || ' ' || event_manipulation)
    FROM information_schema.triggers
  UNION ALL
  SELECT format('sequence %s.%s %s', schemaname, sequencename, coalesce(last_value::text, '-')) FROM pg_sequences
  UNION ALL
  SELECT format('index %s.%s', schemaname, indexname) FROM pg_indexes
   WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
  UNION ALL
  SELECT format('function %s.%s(%s) %s', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid),
                pg_get_userbyid(p.proowner))
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  UNION ALL
  SELECT format('extension %s %s', extname, pg_get_userbyid(extowner)) FROM pg_extension
) AS everything
ORDER BY line;
SQL
}
step "the restored databases match the live one"
snapshot "$LIVE" > "$WORK/live.txt"
for db in "$RESTORED" "$BY_ADMIN"; do
  snapshot "$db" > "$WORK/$db.txt"
  if ! diff -u "$WORK/live.txt" "$WORK/$db.txt"; then
    echo "[drill] FAILED: $db differs from the live database (above)" >&2
    exit 1
  fi
done
echo "[drill] identical: $(grep -c '^rows ' "$WORK/live.txt") tables, $(grep -c '^policy ' "$WORK/live.txt") policies, $(grep -c '^trigger ' "$WORK/live.txt") triggers"
if ! grep -q '^rows domain.events 3 ' "$WORK/$RESTORED.txt"; then
  echo "[drill] FAILED: the drill's three events are not in the restored database" >&2
  exit 1
fi

step "nothing left to migrate"
PENDING=$(cd "$ROOT" && DATABASE_URL="$RESTORED_OWNER_URL" DATABASE_URL_DIRECT="$RESTORED_OWNER_URL" \
  pnpm --silent --filter @compass/db migrate --pending)
if grep -q '^pending: ' <<< "$PENDING"; then
  echo "$PENDING"
  echo "[drill] FAILED: the restored database has migrations pending" >&2
  exit 1
fi

step "the next night's dump, of the restored database"
backup_of "$RESTORED" "$WORK/backups-next"

step "swap the names, as the runbook does"
admin <<SQL
ALTER DATABASE "$LIVE" RENAME TO "$OLD";
ALTER DATABASE "$RESTORED" RENAME TO "$LIVE";
SQL
ORGS=$(psql "$LIVE_OWNER_URL" -X -A -t -v ON_ERROR_STOP=1 \
  -c "SELECT set_config('app.system_context', 'maintenance', false); SELECT count(*) FROM auth.organizations" | tail -1)
if [[ "$ORGS" -lt 1 ]]; then
  echo "[drill] FAILED: the swapped-in database shows the owner no organisation" >&2
  exit 1
fi

echo
echo "[drill] passed"
