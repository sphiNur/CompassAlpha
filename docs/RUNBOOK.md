# Runbook

> Operational handbook. Day 1 of an incident is the wrong time to learn
> these. Read once when you join the team, then bookmark.

## Topology

```
Telegram
  → Cloudflare Worker app-proxy (infra/cloudflare/app-proxy): reads
    the origin's current tunnel URL from the ntfy topic that
    compass-origin-watch publishes to (infra/tunnel); KV keeps the
    newest one
  → cloudflared quick tunnel (compass-app-tunnel.service)
  → nginx on :80 (its config is not in the repo yet: review OPS-23)
  → api on :3000 (compass-api.service): tRPC, /ws, the web bundle
worker (compass-worker.service): the outbox; bot messages go out
  through the tg-relay Worker (infra/cloudflare/tg-relay.js)
Postgres 18, Redis 8 and S3-compatible storage behind both
```

Production runs no containers (`infra/compose/` is the local dev
stack): `scripts/deploy.ts` ships the code to
`/home/ubuntu/compass-alpha`, where bun runs it under systemd
(`infra/systemd/`). See "Roll back a bad deploy" below.

The upload is incremental where both ends have rsync: the server keeps the
last shipped source in `/home/ubuntu/compass-alpha-src/CompassAlpha`, only
changed files are sent, and the server builds the tarball from it. Deleting
that folder is safe; the next deploy seeds it again from the last tarball.
Without rsync (or on Windows) the whole tarball is uploaded with scp.

## Daily

### Health checks
- `https://compass.example.com/health/live` — should return `{status:"ok"}` < 100ms.
- `https://compass.example.com/health/ready` — checks DB + Redis ping. If `degraded`, dig into the JSON.
- `https://compass.example.com/health/version` — confirms the running commit sha.

### Log tailing
Production runs as systemd units (`compass-api`, `compass-worker`), not
docker; their stdout/stderr go to the journal.
```bash
journalctl -u compass-api -f
journalctl -u compass-worker -f
journalctl -u compass-api --since "1 hour ago" | grep '"level":50'   # pino: 50 = error
```

### Triaging client errors
- Open `/debug` in the Mini App (needs `system.logs.view`): the Server tab
  lists the organisation's latest `ops.client_logs` rows.
- From a terminal (there is no `compass logs` CLI command): query
  `ops.client_logs` with psql. It is under RLS by organisation, and rows
  sent before sign-in have no organisation, so open a transaction in the
  system context first:
  ```sql
  BEGIN; SELECT set_config('app.system_context', 'maintenance', true);
  SELECT created_at, org_id, kind, action, error_msg FROM ops.client_logs
   WHERE level = 'error' ORDER BY created_at DESC LIMIT 50;
  COMMIT;
  ```
- Retention (2026-10-21, CA-38): the worker deletes `ops.client_logs` and
  delivered `sync.outbox` rows older than 30 days, and `ops.notifications`
  older than 90 days, once an hour in batches of 5,000 (at most 40 batches
  per table per hour; the rest goes next hour). Look for
  `[worker] retention …` lines in `journalctl -u compass-worker`. Windows
  live in `apps/worker/src/retention.ts`. Undelivered outbox rows
  (`sent_at IS NULL`) are never deleted.

## Common operations

### Grant super_admin to a new user
1. User opens the Mini App → lands on the NoAccess screen → copies their Telegram id.
2. Operator: `pnpm compass user grant <tgUserId> --role super_admin --org default --new-user`.
   Opening the app does not create an account; `--new-user` does. Without it an
   id that has no account is refused, which catches a mistyped id.
3. User reloads the Mini App.

### Roll back a bad deploy
Production is not image-based: `scripts/deploy.ts` ships what git sees
in the local checkout, extracts it over `/home/ubuntu/compass-alpha` (in
place, no `--delete`), runs `pnpm install --frozen-lockfile`, builds the
web bundle into `apps/web/dist.next`, runs
`pnpm --filter @compass/db migrate`, refreshes the systemd units, renames
the bundle into place (`dist` → `dist.prev`, `dist.next` → `dist`), and
only then restarts `compass-api` and `compass-worker` (2026-10-21, CA-37:
the build used to run after the restart, leaving the new api serving a
missing/half-written `dist`). A failed web build aborts the deploy before
the restart and leaves the live `dist` untouched.

Since 2026-11-09 (review OPS-01/OPS-02):
- The read-only checks of the server's `.env` files and database role run
  before anything is uploaded.
- A deploy refuses to start when the nightly backup looks broken: the
  timer is stopped, the last run failed, or the newest dump is more than
  26 hours old. `--allow-stale-backup` overrides; `--rollback` skips it.
- If any step between the extract and the restart fails (extract,
  install, web build, migrate, units, bundle swap), the deploy puts the
  release kept in step 2.5 back, with its own dependencies and units, and
  restarts nothing. The disk then matches what runs again. Migrations
  that already ran stay applied.
- From the extract until a successful restart,
  `/home/ubuntu/compass-alpha/.deploy-incomplete` names the release. If it
  is still there (the undo failed too, or the api did not come up), the
  next deploy keeps the older snapshot instead of that tree, and
  `--rollback` removes the file.

Since 2026-11 (review OPS-03/OPS-04), a server check that cannot run
stops the deploy, the same as one that fails. Before, it printed a
warning and the deploy went on (the `.env` check even passed outright).

- The run-in-progress check: `--allow-active-run` skips it.
- The backup check: `--allow-stale-backup`.
- The `.env` check: no override; fix the server.
- The database role check, which now refuses a superuser as well as
  BYPASSRLS: `--skip-rls-check`.
- The toolchain check (review OPS-21, 2026-11-10): the bun the units
  start (`/home/ubuntu/.bun/bin/bun`) must be `.bun-version`, and the
  pnpm and node on the deploy's PATH must be `packageManager` and meet
  `engines.node`: `--allow-toolchain-drift`. A rollback only warns.

Since 2026-11 (review OPS-05/OPS-06), `COMPASS_BASE` must be set before a
deploy starts, and the provenance gates also refuse unless:

- HEAD is the tip of origin/main as fetched now. A checkout that had not
  pulled used to ship an older main over the live one.
- CI passed for that commit: the three jobs in `.github/workflows/ci.yml`.
  The deploy reads them with `gh`, so install it and run `gh auth login`
  on the deploy machine.
- The live release (`/health/version`) is HEAD or in its history. A
  release deployed with `--force` is not compared.

`--force` overrides these too, and marks the release `-unverified`.

Since 2026-11 (review OPS-07/OPS-08/OPS-09):

- Every step has a time limit: 20 minutes (the unit tests, a step on the
  server), 30 for one rsync attempt, 60 for the scp of the whole
  tarball, 10 for each smoke. ssh gives up on a connection that has not
  answered for two minutes. A step that runs over fails like any other
  failure. Before, a connection that died quietly hung the deploy.
- On the server, a step ends after 18.5 minutes, with everything it
  started, and steps run one at a time
  (`/home/ubuntu/.compass-deploy.lock`). After a lost connection, the
  undo waits for a step that is still running instead of working beside
  it.
- Step 0.4 starts the browser the smokes use, before anything is
  shipped, and refuses when it cannot. `--rollback` only warns.
- After the restart, the deploy waits up to 90 seconds for
  `$COMPASS_BASE/health/ready` to answer 200 before the smokes start. If
  it never does, the deploy stops there and `.deploy-incomplete` stays.
- The server smoke checks that `/health/version` names the release just
  deployed (after `--rollback`, the restored one), from an api started
  after the restart. Any commit used to pass, so a Worker or tunnel
  pointing at another backend went unnoticed.
- The realtime probe gets three tries. A pass that needed more says so.

Since 2026-11 (review OPS-10/OPS-12):

- When the release has a migration to apply, the deploy runs
  `compass-backup.service` first and stops, putting the previous release
  back, if the backup fails. `--allow-stale-backup` migrates without it.
  `pnpm --filter @compass/db migrate --pending` lists what a run would
  apply and changes nothing.
- The web bundle is built into `dist.next` before the migrations and
  swapped in just before the restart. The old api used to run against
  the new schema for the whole build.
- A migration waits at most 3 s for a table lock (review DB-08), so the
  live app never waits longer behind it. The step is tried again after
  2, 5, 10 and 20 s (`↻` lines in the output); each try rolls back
  whole. If every try fails, the deploy stops: look for the long
  transaction in `pg_stat_activity` (`state = 'idle in transaction'`,
  an old `xact_start`, a running `pg_dump`) and deploy again once it
  ends.
- `compass-backup.timer` no longer has `Requires=compass-backup.service`.
  Starting the timer (install, boot) no longer starts a backup, so
  `INSTALL_SKIP_FIRST_RUN=1` works, and stopping a stuck backup no longer
  stops the timer. The deploy's `daemon-reload` applies it.

Since 2026-11 (review OPS-13), a release is what git sees in the local
checkout: tracked files with their local changes, and new files that
`.gitignore` does not hide (`scripts/lib/release.ts`). An ignored file
never ships, and neither does any `.env`, `*.pem`, `*.key`, `*.crt`,
`.claude/` or `.worktrees/`, even if tracked. It used to be the working
tree minus a hand-kept list, which let ignored files through (nested
`node_modules`, `.turbo` caches, test reports) and required the checkout
to be named `CompassAlpha`. Text files ship with LF line endings, whatever
the machine's `core.autocrlf`.

**Frontend-only rollback** (the bad deploy is a UI bug; api is fine): the
previous bundle is kept as `apps/web/dist.prev` for exactly one deploy.
No restart is needed — the api serves `dist` from disk on every request
and `/health/version` reads `dist/build-id.txt`, so clients get the
reload prompt back to the old build:
```bash
cd /home/ubuntu/compass-alpha/apps/web
mv dist dist.bad && mv dist.prev dist   # swap back
# later: rm -rf dist.bad
```
Only valid while the api is compatible with the old bundle (no tRPC
contract change in between); the next deploy overwrites `dist.prev`.

**Full rollback (api + worker + web)** — N9, 2026-10-30. Every deploy
keeps the release that was live before it as
`/home/ubuntu/compass-alpha.prev.tar.gz` (code and built web bundle;
not `node_modules`, not the server's `.env` files) before extracting
anything. To go back to it, from the deploy machine:
```bash
bun run scripts/deploy.ts --rollback --dry   # which release would come back (read-only)
bun run scripts/deploy.ts --rollback         # put it back, restart, verify
```
`--rollback` ships nothing from your checkout (no provenance gates, no
unit tests), but keeps the in-flight-run pre-flight (`--allow-active-run`
overrides it). It restores the tree (the web bundle wholesale), runs
`pnpm install --frozen-lockfile` against the restored lockfile, refreshes
the systemd units, re-runs the `.env` / BYPASSRLS checks, restarts
`compass-api` + `compass-worker` and runs the same smokes as a deploy;
it ends with `ROLLBACK GREEN`. It does not run migrations and does not
rebuild the bundle (the snapshot carries the built one).
- Only one release is kept: the next deploy replaces the snapshot with
  whatever is live at that moment. Rolling back twice in a row restores
  the same release twice.
- The very first deploy made with this script snapshots the release the
  old script left behind, so a rollback is available from that deploy on.
  If that older api predates the realtime probe, the smoke says so and
  checks only that `/ws` answers, instead of failing.
- Files that exist only in the newer release stay on disk (extraction
  does not delete); they are harmless unless something imports them.
- Migrations only move forward: rolling back does NOT undo a migration
  the bad deploy applied. If old code cannot run against the newer
  schema, restore the dump the deploy took before migrating (see
  "Restore from a dump" below) and accept losing writes made since that
  dump.
- By hand, without the deploy machine (then restart and check yourself):
  ```bash
  cd /home/ubuntu/compass-alpha
  tar -tzf ../compass-alpha.prev.tar.gz >/dev/null      # readable?
  mv apps/web/dist apps/web/dist.bad && tar -xzf ../compass-alpha.prev.tar.gz -C .
  pnpm install --frozen-lockfile && sudo systemctl restart compass-api compass-worker
  ```

**Redeploying an older commit** is still possible:
```bash
git checkout <last-good-sha>            # detached HEAD
bun run scripts/deploy.ts --force       # --force: not the tip of main
git checkout main
```
- `--force` skips the provenance gates and marks the release sha
  `-unverified` in `/health/version`; add `--allow-active-run` only if you
  accept forcing a reload on clients in a live run.

### Deploy host key (N9)
`scripts/deploy.ts` connects with `StrictHostKeyChecking=yes` against the
keys pinned in `infra/deploy/known_hosts` (taken with `ssh-keyscan` on
2026-10-30 and identical to the keys the deploy Mac had already
accepted). The host names in that file are hashed, so the public repo
does not name the server; `ssh-keygen -F <host> -f
infra/deploy/known_hosts` finds them. A host that is not in that file,
or presents another key, is refused. If the server is rebuilt or moves:
read the new key fingerprints from the provider console, compare them
with `ssh-keyscan <host> | ssh-keygen -lf -`, and only then replace the
lines in the file with `ssh-keyscan -H <host>` (hashed), or point
`COMPASS_DEPLOY_KNOWN_HOSTS` at another file.

### Workspace-wide purges are off on production (D1/D5)
`admin.purgeAllTestData` (清空整个工作区) and `admin.purgeByDate`
(重置指定日期) refuse with `bulkPurgeDisabledInProduction` when the api
runs with `NODE_ENV=production` or `COMPASS_RELEASE_CHANNEL=production`.
Deleting a single order or market run on the maintenance page is not
affected. `packages/db/src/purge-fake-data.ts --apply` refuses on the same
signals and also on any host where `compass-api.service` is installed.
For a deliberate maintenance window, take a backup first, then set
`COMPASS_ALLOW_BULK_PURGE=true` in the server `.env` and restart the api
(or prefix the script command with it); remove it again afterwards.

### Sign the origin rendezvous (CA-12)
The app-proxy Worker (`infra/cloudflare/app-proxy/`) learns the current
quick-tunnel hostname from an ntfy topic. Anyone who knows the topic name
can post to it, so since 2026-10-21 the messages can be HMAC-signed. Both
halves are backward compatible — an unsigned Worker accepts signed
messages and an unsigned server keeps working with a Worker that has no
secret — but a Worker WITH the secret ignores unsigned messages, so do the
server first:
```bash
# 1. generate a key (on your machine; do not commit or paste it anywhere)
openssl rand -hex 32
# 2. server: store it next to the topic file, readable only by ubuntu
install -m 600 /dev/null /home/ubuntu/.config/compass-origin.key
printf '%s\n' '<key>' > /home/ubuntu/.config/compass-origin.key
sudo systemctl start compass-origin-watch.service   # republishes at once, signed
journalctl -u compass-origin-watch -n 5             # "published … (signed)"
# 3. Worker: same key as a secret (wrangler prompts for the value)
cd infra/cloudflare/app-proxy && wrangler secret put ORIGIN_SIGNING_KEY
```
The watchdog republishes every 6 h; the Worker rejects signed messages
older than 6 h 30 min or more than 5 minutes in the future, and any
message older than the newest one it already accepted (KV `signedTs`).
After a Worker restart it serves the last accepted origin from KV `url`
until a fresh message arrives. If the app goes
unreachable after step 3, check the server clock and that both sides hold
the same key; `wrangler secret delete ORIGIN_SIGNING_KEY` reverts the
Worker to unsigned mode. Rotating: write the new key on the server, run
the service, then `wrangler secret put` the new key.

### Replay a projection
If a projector bug corrupted `read_model.order_sessions_v`:
```bash
cd /home/ubuntu/compass-alpha
set -a && . ./.env && set +a
pnpm --filter @compass/api reproject --type=order   # or --type=run, or omit for all
```
`apps/api/scripts/reproject.ts` truncates the read model tables and replays
`domain.events` in one transaction (asks for confirmation; `--yes` skips it).
It opens its pool in the `maintenance` system context, so it works under the
fail-closed RLS policies with the normal app role. Idempotent. (`compass
project rebuild` is not implemented; it only points here.)

### Add a new built-in permission
1. Add to `packages/db/src/seed-data.ts` `PERMISSIONS`.
2. Add to relevant role's permissions list. New organisations get it from
   `provisionOrganization`.
3. Existing organisations: write a numbered migration that inserts the key
   into `auth.permissions` and grants it to the built-in roles that should
   hold it, `ON CONFLICT DO NOTHING`, never removing anything. Copy 0048 /
   0054 / 0059. Deploys run `migrate`, not `seed`. Never run `pnpm db:seed`
   on a server: it is the local-development seed and refuses to run in
   production. It would write demo stores and products into a real tenant
   and give back keys an admin had removed.
4. Wire the check in the relevant tRPC router via `permissionProcedure('your.new.key')`.
5. Update `docs/PERMISSION_MATRIX.md`.

### Investigate a CONFLICT on `order.adjustItem`
The likely cause is two writers racing on the same `(streamId, seq)`. The retry path is
client-side: tRPC error → optimistic local replay → refetch + re-apply. If you see
sustained CONFLICT in logs:
1. Check `domain.events` for the affected `streamId` — look at `actorId` distribution.
2. If the same actor is colliding with itself, the FE has duplicate inflight mutations
   (likely a missing useMutation key). File against the FE.
3. If two different actors are racing, that's expected concurrent editing — verify the
   read model is converging within ~1s. If not, projector lag → check
   `domain.projector_cursors.lag`.

## Incident response

### Postgres at 100% CPU
1. `SELECT * FROM pg_stat_activity WHERE state = 'active' ORDER BY query_start;`
2. Find the offender query; cancel with `pg_cancel_backend(pid)`.
3. `EXPLAIN ANALYZE` it; check if the index it should use is still there.
4. If a missing index, add a migration; never `CREATE INDEX` ad-hoc on prod (no audit trail).

### Redis OOM
- Increase `maxmemory` in compose or upgrade plan.
- Audit which keys are growing. Most likely: BullMQ job history. Set `removeOnComplete`
  + `removeOnFail` on producers.

### `/health/ready` says `projectorLag > 60s`
- Worker process probably crashed. `systemctl status compass-worker`.
- Restart: `sudo systemctl restart compass-worker`.
- Investigate: `journalctl -u compass-worker --since "1 hour ago" --no-pager`.

### Cross-tenant data appears in a query
This is an RLS regression. Critical.
1. Page the on-call.
2. Confirm the offending route ran with `app.current_org_id` set: check
   `domain.policy_decisions` for the user's recent decisions; cross-reference with
   `domain.events.org_id`.
3. If RLS was bypassed, the API's `withOrg()` helper is the only place that should
   set the GUC. Check `apps/api/src/trpc/context.ts` — any new helper code that ran
   without the helper is the suspect.
4. Add the regression test to `tests/integration/rls.test.ts`.

## Backups

Implemented in `infra/backup/`. Nightly `pg_dump -Fc` to disk, 14-day retention,
optional off-site upload to any S3-compatible bucket.

- **Schedule**: 03:30 UTC daily (08:30 Asia/Tashkent — well after morning rush,
  well before lunch). systemd timer `compass-backup.timer`.
- **Format**: pg_dump custom (`-Fc`) — fast parallel restore, internally
  compressed.
- **Local path**: `/home/ubuntu/compass-backups/compass-YYYY-MM-DD-HHMMSS.dump`
- **Verification**: every dump is checked for size > 1 KiB and `pg_restore --list`
  parses cleanly. Failures fail the systemd unit (visible in
  `systemctl status compass-backup.service`).
- **Retention**: local dumps older than 14 days are deleted. Disk: 30 GB free,
  dumps are ~MB-scale.
- **Off-site (optional)**: set `BACKUP_S3_BUCKET`, `BACKUP_S3_PREFIX`, and
  `BACKUP_S3_ENDPOINT` in `.env`. Works with Yandex Object Storage / Tencent COS /
  MinIO / AWS S3 via the `aws` CLI. Once a bucket is set, a failed upload or a
  missing `aws` CLI fails the unit (exit 1, `[backup] ERROR: …` in the journal);
  the local dump is kept. (Until 2026-10-30 both only logged WARN and exited 0.)
- **Failures** print one `[backup] FAILED (exit N) at line L: <command>` or
  `[backup] ERROR: …` line and exit non-zero, so the unit shows `failed`.
  A deploy refuses to start while that is so, or while the timer is
  stopped or the newest dump is over 26 hours old (`--allow-stale-backup`
  overrides), so a broken backup is noticed at the next deploy at the
  latest. Nothing alerts when it happens yet. To add alerting the owner needs to choose:
  where alerts go (Telegram chat/bot, email, ntfy topic, …), who receives
  them, and whether a missing nightly run (not only a failed one) should
  alert — e.g. an `OnFailure=` unit that posts to the chosen channel plus a
  daily check that the newest dump is < 26 h old.
- **Recovery target (M1.1)**: ≤ 24 h RPO, ≤ 1 h RTO. WAL streaming + sub-15-min
  RPO is on the M2 backlog.

### One-time install (server)
```bash
# After first deploy that ships infra/backup/
sudo bash /home/ubuntu/compass-alpha/infra/backup/install.sh
# Skips the immediate first run if you don't want it:
INSTALL_SKIP_FIRST_RUN=1 sudo bash …/install.sh
```
The installer is idempotent — re-run any time to pick up unit changes. It
also gives the backup role (the user in `BACKUP_DATABASE_URL`) SELECT on
every table and sequence, and on those later migrations create
(`infra/backup/grant-backup-role.sql`, default privileges for the user in
`DATABASE_URL_DIRECT`). Re-run it after a migration adds a schema.

### Verify it's running
```bash
systemctl list-timers compass-backup.timer
journalctl -u compass-backup.service -n 50 --no-pager
ls -lh /home/ubuntu/compass-backups/
```

### Trigger an immediate backup
```bash
sudo systemctl start compass-backup.service   # oneshot — returns when done
journalctl -u compass-backup.service -n 50 --no-pager
```

### Restore from a dump
`restore.sh` restores into a NEW, empty database, never over the live
one (review OPS-11, 2026-11-10). Restoring over the live database
failed whenever the role did not own every object it had to drop, or
the database held something newer than the dump, and left nothing to
go back to. Now the live database stays as it is until the restored one
has been checked, and the swap can be undone. CI rehearses every step
below on each change (`infra/backup/drill.sh`, job `restore-drill`);
its dump restores in about a second.

1. Make the new database, owned by the role the migrations run as: the
   user in `DATABASE_URL_DIRECT`, or in `DATABASE_URL` without it
   (`compass` below).
   ```bash
   sudo -u postgres createdb -O compass compass_restored
   ```
2. Restore into it as that role: the restored tables belong to the role
   that restores them, and the next migration must own them. Where only
   a superuser can connect, name that role in `RESTORE_OWNER`; without
   it the script refuses a superuser. It also refuses a database that
   is not empty, uses `--single-transaction` (a failure leaves the
   database empty), and gives the backup role its SELECT again.
   ```bash
   cd /home/ubuntu/compass-alpha
   RESTORE_DATABASE_URL='postgresql://compass:…@localhost/compass_restored' \
     bash infra/backup/restore.sh        # lists the dumps; or name one
   ```
3. Check it before anything else changes: the newest rows you expect to
   find, such as the last run and the last daily close.
4. Swap the names. The api and the worker hold connections to the live
   database, so stop them first. The old database is kept.
   ```bash
   sudo systemctl stop compass-api compass-worker
   sudo -u postgres psql -c 'ALTER DATABASE compass RENAME TO compass_before_restore' \
     -c 'ALTER DATABASE compass_restored RENAME TO compass'
   ```
5. Migrate (an older dump may lack the release's newest migrations),
   start, and run the server smoke from your machine:
   ```bash
   cd /home/ubuntu/compass-alpha && pnpm --filter @compass/db migrate
   sudo systemctl start compass-api compass-worker
   COMPASS_BASE=https://compass-alpha.sphinxr.workers.dev bun run scripts/smoke.ts
   ```
   If the api connects as a role other than the owner (restore.sh warns
   when it does), give it its grants again first: a dump carries none
   (`--no-privileges`).
6. Once all is well: `sudo -u postgres dropdb compass_before_restore`.
   Until then, to undo: stop, swap the names back, start.

On a new server a dump brings no roles. Create them first, with the
passwords from the old `.env`: `compass` (LOGIN, NOSUPERUSER,
NOBYPASSRLS) and `compass_backup` (LOGIN, BYPASSRLS); then the steps
above with the database name from `.env`, and `install.sh` for the
nightly timer.
