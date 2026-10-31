# shellcheck shell=bash
#
# Keep a Postgres password off the command line (security scan F11,
# 2026-10-31). Sourced by compass-backup.sh and restore.sh.
#
# They used to pass the whole connection URL, password included, to
# pg_dump / pg_restore as an argument. For the length of the run any
# local account can read that from `ps` or /proc/<pid>/cmdline, and the
# backup role bypasses row-level security: its password reads every
# tenant's data.
#
#   pg_url_split "$URL"
#
# sets PG_URL_NOPASS to the URL with the password removed and exports
# PGPASSWORD with the (percent-decoded) password, which libpq reads from
# the environment; /proc/<pid>/environ is readable only by the same user
# and root. A URL without a password leaves PGPASSWORD untouched (a
# ~/.pgpass file or peer auth then applies as before).

pg_url_split() {
  local url="$1" pass
  # scheme://user:password@host... — the user part has no ':' '/' '@'.
  if [[ "$url" =~ ^([A-Za-z][A-Za-z0-9+.-]*://[^:/@]*):([^@]*)@(.*)$ ]]; then
    pass="${BASH_REMATCH[2]}"
    PG_URL_NOPASS="${BASH_REMATCH[1]}@${BASH_REMATCH[3]}"
    # Percent-decode (a URL escapes @ : / % and friends in a password);
    # a literal backslash is doubled first so printf keeps it as is.
    pass="${pass//\\/\\\\}"
    PGPASSWORD="$(printf '%b' "${pass//%/\\x}")"
    export PGPASSWORD
  else
    PG_URL_NOPASS="$url"
  fi
}
