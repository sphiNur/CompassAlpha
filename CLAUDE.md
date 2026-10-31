# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

CompassAlpha is a multi-store procurement system shipped as a Telegram Mini App, in production with paying customers. It runs on one server behind a Cloudflare Worker (https://compass-alpha.sphinxr.workers.dev). The Fine app (Flutter, separate repo `../Fine`) calls the same API and database.

Read `README.md` (setup, layout), `CONTRIBUTING.md` (the end-to-end feature recipe and conventions) and `ARCHITECTURE.md` before larger changes. `docs/RUNBOOK.md` covers deploy, rollback, backups and the production switches. This file only adds what those don't make obvious.

## Commands

Bun 1.1.38 (`.bun-version`), pnpm 9, Postgres 16 on port 5433.

```bash
pnpm type-check                      # tsc in every package (CI)
pnpm lint                            # eslint (CI); e.g. no-case-declarations fails the build
bun run scripts/check-untranslated.ts

# Unit tests, exactly as CI runs them (PG-gated tests skip themselves):
SKIP_PG_TESTS=1 bun test packages/domain packages/i18n packages/ui apps/api apps/worker apps/web/src scripts
bun test packages/domain/src/run/state.test.ts          # one file
bun test packages/i18n -t "catalog lint"                 # by test name

# PG integration tests: migrate a throwaway DB first, then point DATABASE_URL at it.
DATABASE_URL=postgres://…/compass_test_x DATABASE_URL_DIRECT=postgres://…/compass_test_x pnpm --filter @compass/db migrate
DATABASE_URL=postgres://…/compass_test_x JWT_SECRET=<≥32 chars> JWT_REFRESH_SECRET=<≥32 chars> TELEGRAM_BOT_TOKEN=ci-stub:bot bun test apps/api
```

- `packages/db` migrate reads `DATABASE_URL_DIRECT` (from `.env`) before `DATABASE_URL`. Always set both explicitly to the database you mean; a copied `.env` once pointed migrations at the shared dev DB.
- CI runs the integration tests as a non-owner, non-BYPASSRLS role (`compass_ci_app`). A few event-store guard tests fail locally when you run them as the table owner; that is expected.
- Workspace packages are linked through `node_modules`. If a package gains a dependency on another workspace package (e.g. `@compass/domain` → `@compass/contracts`), a checkout or worktree that was not reinstalled needs the link (`packages/domain/node_modules/@compass/contracts → ../../../contracts`) or local tsc and the deploy's unit-test gate fail.

### Running the web app locally

`apps/web` needs both `VITE_API_URL=http://localhost:<api>` and `VITE_WS_URL=ws://localhost:<api>/ws`; without the second the page connects to vite's own `/ws` and never receives realtime pushes. Several vite servers started from the same `apps/web` at once must each get their own `cacheDir`, or they overwrite `node_modules/.vite` and pages white-screen with two copies of React. `VITE_ENABLE_MAINTENANCE=1` shows the maintenance page.

## Architecture in brief

- **Event sourced.** `packages/domain` holds pure aggregates: `events.ts` (payloads are frozen public contracts; change = new event type), `state.ts` (`apply`), `commands.ts` (`decide`). The API appends to `domain.events` and projects into `read_model.*` in the same transaction (`apps/api/src/services/*Projection.ts`). The web reads the read models through tRPC.
- **Event store is append-only in the database.** A trigger refuses UPDATE/DELETE/TRUNCATE on `domain.events`. Paths that must delete events (maintenance purges, `purge-fake-data.ts`) call `allowEventPurge(tx)` first, which is transaction-local.
- **Multi-tenancy is enforced by RLS** (FORCE RLS). API code runs inside `ctx.withOrg(...)`. Worker/maintenance code uses a system context; `app_is_system()` accepts only the `SystemReason` values (`auth`, `worker`, `health`, `maintenance`, `telemetry`). For read-only psql checks: `select set_config('app.system_context','maintenance',false);`.
- **Realtime.** `hub.publish` defers messages until the transaction commits (nothing is sent on rollback). The worker announces its own changes with `pg_notify('compass_realtime', …)`, relayed by the API (`apps/api/src/realtime/dbRelay.ts`). `/ws?probe=1` is a token-less probe used by the deploy smoke.
- **Writes from the web.** Mutations go through an IndexedDB outbox (`apps/web/src/hooks/useOfflineQueue.ts`) and replay on reconnect with idempotency keys. Procedures that accept a key are listed in `IDEMPOTENT_MUTATIONS` (`apps/web/src/lib/trpc.ts`); a test fails if the server accepts a key the client does not send. Read queries are persisted per user/org/build for offline start (`apps/web/src/lib/queryPersist.ts`); `public/sw.js` serves the shell offline in production builds.
- **Optimistic concurrency.** Commands carry `expectedSeq` from the screen; the server refuses a stale one (`staleSeq`).
- **Money.** One rule for every total: each line `qty × price` rounded half-up to cents, totals added in integer cents (`packages/contracts/src/money.ts`; the SQL side is `runMoneyLinesSql` in `apps/api/src/services/runMoney.ts`). Prices have ≤ 2 decimals, quantities ≤ 3. Do not sum floats in new code.
- **Prices are permissioned.** A reader sees amounts for a store only with effective `prices.view` there (roles + allow/deny overrides); the server nulls money fields otherwise. New endpoints that return money must follow this.
- **Numbers typed by people** go through the shared decimal field / parser in `packages/ui` (`useDecimalField`, `readDecimalText`), which keeps the raw text while typing and reads separators per UI language.

## i18n

Four catalogs in `packages/i18n/src/catalogs/` (`en.ts` defines the key type). Server errors are thrown with the i18n key as the message. `packages/i18n/src/__tests__/catalog-lint.test.ts` is a CI gate: placeholders identical across languages, Uzbek ʻ/ʼ (not ASCII apostrophes), CLDR plurals (ru needs one/few/many/other and `#` in `one`), no developer terms, zh full-width punctuation, and the decided glossary (审核, 验收 / 确认收货, 商品, 采购员, 日结). Product decisions behind these rules are recorded in `../Fine/docs/redesign/16-决策记录.md`.

## Deploying

Deploys run from a developer machine, only when the owner asks:

```bash
COMPASS_DEPLOY_HOST=ubuntu@<host> COMPASS_DEPLOY_KEY=<key> \
  COMPASS_BASE=https://compass-alpha.sphinxr.workers.dev bun run scripts/deploy.ts
bun run scripts/deploy.ts --rollback --dry   # show what a rollback would restore
```

- The script refuses a dirty tree, an unpushed HEAD, or any run in purchasing/delivering/amending (`--allow-active-run` exists; don't use it without the owner).
- It runs the unit tests locally first, then: snapshot of the live release for `--rollback`, tar/scp, migrations, restart, and three smokes against `COMPASS_BASE`: server (`scripts/smoke.ts`, including the realtime probe and "dev login is off"), render, and a deep browser walk that stubs login and every mutation.
- The SSH host key is pinned in `infra/deploy/known_hosts`.
- The smokes assert some English UI strings and nav labels. Renaming copy can fail a deploy smoke: update `scripts/browser-smoke*.ts` in the same PR.
- The Cloudflare Worker (`infra/cloudflare/app-proxy`) is deployed separately with wrangler, not by `deploy.ts`.
- Production switches: `COMPASS_ALLOW_BULK_PURGE` (bulk wipes are refused in production without it); `CLIENT_IP_PROXY_KEY` (the Worker's trusted client-IP header for rate limiting; see that README).
