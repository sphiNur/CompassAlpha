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

All four app processes share the same image (`compass:latest`), differing only in
their CMD. This means a single `docker compose pull && docker compose up -d`
deploy ships the whole system atomically.

## Daily

### Health checks
- `https://compass.example.com/health/live` — should return `{status:"ok"}` < 100ms.
- `https://compass.example.com/health/ready` — checks DB + Redis ping. If `degraded`, dig into the JSON.
- `https://compass.example.com/health/version` — confirms the running commit sha.

### Log tailing
```bash
docker compose -f infra/compose/docker-compose.prod.yml logs -f api
# or via Loki:
logcli query '{service="compass-api"}' --tail
```

### Triaging client errors
- Open `/debug` in the Mini App — Unreviewed tab shows new client_logs.
- After scanning + fixing, hit "Mark all reviewed" so the cursor advances.
- Run the same audit from a terminal: `compass logs tail --org default --level error`.

## Common operations

### Grant super_admin to a new user
1. User opens the Mini App → lands on the NoAccess screen → copies their Telegram id.
2. Operator: `pnpm compass user grant <tgUserId> --role super_admin --org default`.
3. User reloads the Mini App.

### Roll back a bad deploy
```bash
docker tag compass:previous compass:latest
docker compose -f infra/compose/docker-compose.prod.yml up -d api bot worker
```
The image tag scheme is `compass:<gitsha>`. Always keep the previous tag around.

### Replay a projection
If a projector bug corrupted `read_model.order_sessions_v`:
```bash
pnpm compass project rebuild order
```
This drops the read model tables and replays events from `domain.events`. Idempotent.

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
- Worker process probably crashed. `docker compose ps`.
- Restart: `docker compose restart worker`.
- Investigate: `compass logs tail --service worker --level error`.

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
  MinIO / AWS S3 via the `aws` CLI. Upload failure does NOT fail the backup —
  the local dump is still good.
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
