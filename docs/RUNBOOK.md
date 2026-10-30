# Runbook

> Operational handbook. Day 1 of an incident is the wrong time to learn
> these. Read once when you join the team, then bookmark.

## Topology

```
            Caddy (TLS, edge)
               │
        ┌──────┴───────┐
        │              │
    api (3000)     bot (long-poll)   worker (BullMQ)
        │
   ┌────┴────┬───────────┐
   │         │           │
Postgres  Redis        S3/R2
```

Production does not run the docker images in `infra/compose/`: the code is
shipped as a tarball by `scripts/deploy.ts` to `/home/ubuntu/compass-alpha`
and run with bun under systemd (`infra/systemd/compass-api.service`,
`compass-worker.service`). See "Roll back a bad deploy" below.

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
- Open `/debug` in the Mini App — Unreviewed tab shows new client_logs.
- After scanning + fixing, hit "Mark all reviewed" so the cursor advances.
- From a terminal (there is no `compass logs` CLI command): query
  `ops.client_logs` with psql. RLS is fail-closed, so open a transaction in
  the system context first:
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
2. Operator: `pnpm compass user grant <tgUserId> --role super_admin --org default`.
3. User reloads the Mini App.

### Roll back a bad deploy
Production is not image-based: `scripts/deploy.ts` tars the local working
tree, extracts it over `/home/ubuntu/compass-alpha` (in place, no
`--delete`), runs `pnpm install --frozen-lockfile` and
`pnpm --filter @compass/db migrate`, refreshes the systemd units, builds
the web bundle into `apps/web/dist.next` and renames it into place
(`dist` → `dist.prev`, `dist.next` → `dist`), and only then restarts
`compass-api` and `compass-worker` (2026-10-21, CA-37: the build used to
run after the restart, leaving the new api serving a missing/half-written
`dist`). A failed web build aborts the deploy before the restart and
leaves the live `dist` untouched.

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
  schema, restore the pre-deploy dump (see "Restore from a dump" below —
  take one with `sudo systemctl start compass-backup.service` before
  risky deploys) and accept losing writes made since that dump.
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
keys pinned in `infra/deploy/known_hosts` (129.204.59.183; taken with
`ssh-keyscan` on 2026-10-30 and identical to the keys the deploy Mac had
already accepted). A host that is not in that file, or presents another
key, is refused. If the server is rebuilt or moves: read the new key
fingerprints from the provider console, compare them with
`ssh-keyscan <host> | ssh-keygen -lf -`, and only then replace the lines
in the file (or point `COMPASS_DEPLOY_KNOWN_HOSTS` at another file).

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
older than 7 days or more than 5 minutes in the future. If the app goes
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
2. Add to relevant role's permissions list.
3. Run `pnpm db:seed` (idempotent — only inserts the missing rows).
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
  Nothing alerts on that yet. To add alerting the owner needs to choose:
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
The installer is idempotent — re-run any time to pick up unit changes.

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

### Restore from a dump (DESTRUCTIVE)
```bash
# Interactive — pick from list:
sudo -u ubuntu bash /home/ubuntu/compass-alpha/infra/backup/restore.sh

# Specific file:
sudo -u ubuntu bash /home/ubuntu/compass-alpha/infra/backup/restore.sh \
  /home/ubuntu/compass-backups/compass-2026-05-04-033000.dump

# Restore into staging instead of prod DB:
DATABASE_URL=postgresql://… bash restore.sh <dump>
```
The script asks for `yes` confirmation before running `pg_restore`. It uses
`--single-transaction` so a partial failure rolls back instead of leaving the
DB half-migrated.
