# shellcheck shell=bash
#
# env_get KEY [FILE]: the value of KEY in a dotenv file (FILE, or
# $ENV_FILE when none is given), without one level of double quotes;
# empty when the file or the key is missing. The first `KEY=` line wins.
#
# Review OPS-32 (2026-11-12): compass-backup.sh, restore.sh, install.sh
# and scripts/deploy.ts each had their own copy of this line. The deploy
# sends this file's text along with its database checks, so they also run
# on a server whose release is older than this file.

env_get() {
  grep -E "^$1=" "${2:-${ENV_FILE:-}}" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^"\(.*\)"$/\1/' || true
}
