# Roadmap — what's done, what's next

> Honest status as of **2026-05-07** (refreshed). The original 2026-05-01
> M1 punch list is preserved below for archaeology; everything that
> shipped between 05-01 and 05-07 is captured in the **M1.1 – M1.9
> changelog** at the top.

## 📜 M1.1 – M1.9 changelog (2026-05-02 → 2026-05-07)

These are the named milestone slices that landed AFTER the original
2026-05-01 push. Each was either a missing-feature follow-up, an
architecture refinement, or a pre-launch hardening pass. Inline code
comments use the `M1.x (YYYY-MM-DD)` marker for cross-reference.

### M1.1 – M1.2 (Per-store admin gates) — 2026-05-04 → 05-06

- **C1 rank gate**: a manager can only grant roles below their own rank.
  Server check in `admin.grantRole`; FE in `GrantRoleSheet`.
- **C2 admin-of-store gate** (`getActorAdminStoreIds`): a store-scoped
  admin can only invite / grant / assign / detach in the stores they
  themselves administer. Org-tier roles require global admin.
- **D1 atomic detach**: `admin.memberDetachFromStore` deletes the
  member-store assignment + revokes store-scoped role bindings + drops
  store-scoped permission overrides in one tx.
- **D2 transfer wizard**: move a member between stores with optional
  role-mirroring (M1.9 hides this UI from non-global admins).
- **B1 / B2 admin audit**: every catalog/role/permission write fans
  out to `domain.policy_decisions` with optional `scope_store_id` for
  per-store filtering.

### M1.3 (Lazy-load + bundle hygiene) — 2026-05-04

- AdminPage code-split via `React.lazy`; main bundle drops ~160 KB.
- Per-page route-level imports keep cold first-paint under 1 s.

### M1.4 (Store-first navigation) — 2026-05-05

- Admin page rebuilt around 5 sections: Organization / Stores /
  Roles & Permissions / Catalog / Operations.
- StoreDetailScreen with Team / Settings tabs; Org-level pseudo-store
  for admin/super_admin without store assignments.
- Sheet-stack BackButton counter (`useSheetCount`) so Telegram's native
  back arrow drills out of nested sheets correctly.

### M1.5 (Run preview + audit pass) — 2026-05-06

- `previewCreatable` returns `perStoreDemand` + `supplierBySku`.
- Run page gets segmented "Overall / By store / By vendor" view.
- Vendor copy-paste template (store-major, minimal greeting).
- Per-SKU preferred-vendor picker. Audit doc: `docs/M1.5-AUDIT.md`.

### M1.6 (i18n in Admin + Settings sheet) — 2026-05-06

- Admin page strings go through `i18n.t(...)` (was English-only).
- Telegram gear button opens richer `SettingsSheet` (Profile / Language
  / About) instead of just a language picker.
- Run page in-flight supplier reassignment (`VendorPickerSheet`).

### M1.7 (Migration consistency check + cancel-run polish) — 2026-05-07

- `packages/db/src/migrate.ts` fails-fast on orphan/ghost migrations
  before applying (closes the silent-skip class that broke 0009).
- Run history filter chips: 已完成 / 含已取消 / 仅取消.
- Cancel reason becomes optional with soft-encourage banner.
- `Unapproved` event now CLEARS the claim (audit HIGH #4): chain
  owners can undo a manager's mistaken approval without leaving the
  order stuck on themselves.

### M1.8 (Session-level "其他物品" notes) — 2026-05-07

- New `SessionNoteSet` event, `SetSessionNote` command, `notes` column
  on `read_model.order_sessions_v` (migration 0010).
- OrderPage textarea (debounced save), ApprovalPage banner + "📝" pill
  on the queue card, RunPage byStore + ActiveRun PerStoreView display.
- Vendor copy-paste appends the notes block.
- 4-language i18n + 6 new domain unit tests.

### M1.9 (Pre-launch hardening) — 2026-05-07

- **B1**: `manager` role gets `users.manage` (migration 0011 backfills
  existing orgs). Per-store managers can now invite into their stores;
  cross-store gates already in place.
- **B2**: `previewCreatable` IN-array bind fixed (was silently
  returning no rows; storeName showed as "—").
- **B3**: Telegram HMAC compare hardened to `crypto.timingSafeEqual`
  with explicit length pre-check + auth_date null-guard. New
  `apps/api/src/__tests__/telegramAuth.test.ts` pins reject reasons.
- **B5**: `system.log` rate-limited 60/min/IP (was unlimited).
- **H1**: MaintenanceSection double-gated (super_admin AND
  `VITE_ENABLE_MAINTENANCE=1`) — "Reset today" no longer a launch-day
  footgun.
- **H2**: RoleCreate / TransferStore / CloneRoles / MemberPermissions
  sheet / embedded DebugPage / audit JSON viewer hidden for non-global
  admins. Server-side gates unchanged.
- **H3**: WorkspaceSection `futureNote` placeholder + raw `slug` field
  removed.
- **i18n leak sweep**: ConfirmPage chip labels (ok/short/wrong/quality),
  RunPage delivery stage labels + Splits validation + history sheet
  Loading/NoData, OrderPage SKU row meta + chip-bar, ApprovalPage
  card meta + locale-aware timestamp. 535 → 544 keys × 4 langs.
- **Projector follow-up**: `Unapproved` projector branch now mirrors
  the M1.7 state.ts change (clear claim, not transfer).
- **CI**: `.github/workflows/ci.yml` — type-check + unit tests + i18n
  parity + migration-journal consistency on push/PR. Was zero CI.

### Operational
- `infra/backup/` (pg_dump nightly, 14d retention, optional S3 push,
  `restore.sh` documented in `docs/RUNBOOK.md`).
- `compass-worker.service` systemd unit shipped + auto-installed by
  `scripts/deploy.ts`.

## 🟢 Operational tooling — DONE (autonomous session 2026-05-01)

These weren't on the original milestone plan but landed alongside the M1
push and are now part of the deploy contract:

- [x] **Smoke harness** — `scripts/smoke.ts` (27 server-side checks, ~5 s)
      + `scripts/browser-smoke.ts` (12 Playwright/Chromium checks, ~10 s).
      Replays the bug classes we shipped earlier (`WebAppBottomButtonParamInvalid`,
      blank screen on module-load failure, ICU plural template rendering)
      so they fail in CI not on iPhone Telegram.
- [x] **`scripts/deploy.ts`** — one command: tar + scp + extract + pnpm
      install + systemctl restart api+worker + vite build + run both
      smokes. Non-zero exit if anything regresses against the live URL.
- [x] **HTML cache fix** — nginx `Cache-Control: no-store, no-cache,
      must-revalidate` on `/`. Long-cache `immutable` only on hashed
      assets. iPhone Telegram WebView can't trap users in stale HTML.
- [x] **Build-id sync** — vite plugin emits `dist/build-id.txt`; API's
      `/health/version` reads it; client `useVersionCheck` polls and
      shows a "new version, tap to reload" Toast on mismatch (auto-reload
      after 30 s if untapped).
- [x] **Workspace TS-clean** — `pnpm -r exec tsc --noEmit` exit 0 across
      all 12 packages. Used as a pre-deploy check.
- [x] **Bundle hygiene** — debug-leak smoke checks "Run network diagnostic"
      and "TgBotGemini" never make it into a prod bundle.

## ✅ Milestone 0 — Foundation (DONE)

- [x] Monorepo: pnpm + turbo + tsconfig + .env wiring
- [x] `packages/db`: Drizzle schema (auth/inventory/domain/read_model/ops/sync), generate + migrate runner with PRE/POST raw SQL split, RLS policies, seed
- [x] `packages/domain`: `decide()` + `apply()` for both `order` and `run` aggregates, Result/Error types, fixed-clock test util, 9 order unit tests
- [x] `packages/contracts`: Zod schemas for every router input/output (auth, catalog, order, run, delivery, admin, system)
- [x] `packages/ui`: Concord tokens (`tokens.css`), 13 components (Button/Card/Input/Sheet/Banner/Spinner/EmptyState/DataState/Skeleton/Stepper/Chip/Avatar/Badge/QtyControl), `ThemeProvider`
- [x] `packages/i18n`: ICU-lite runtime + en/zh/ru/uz catalogs (en complete; uz partial → falls back)
- [x] `packages/telemetry`: client logger with ring buffer + batched flush + dedupe
- [x] `packages/cli`: `compass org / user / test / project` commands, auto-provisions users on `user grant`
- [x] `apps/api`: Hono + tRPC v11 + Drizzle, native `Bun.serve`, RLS-aware `withOrg`, JWT with rotating refresh family, Telegram initData verifier
- [x] `apps/web`: Vite + React 18 + Tailwind v4 + TanStack Query + tRPC client + AuthGate
- [x] `apps/bot`: grammY `/start` + `/id` (notification dispatch is M2)
- [x] `apps/worker`: BullMQ skeleton (jobs land in M1/M2)
- [x] `infra/`: Dockerfile multi-stage, dev compose (PG + Redis + MinIO + Adminer), prod compose, Caddyfile
- [x] `docs/`: ARCHITECTURE / EVENT_CATALOG / PERMISSION_MATRIX / API / DESIGN / RUNBOOK

**Smoke validated**:
- `compose up -d` → 4 containers healthy (PG@5433, Redis@6380, MinIO@9000, Adminer@8080)
- `db:generate` + `db:migrate` + `db:seed` → 1 org, 5 roles, 23 perms, 18 SKUs, 2 stores, 3 suppliers
- `compass user grant 6402913074 --role super_admin --org default` → user + member + binding created
- API up at `:3000` (`/health/live`, `/health/version`, `/trpc/system.health` 200 OK)
- Web up at `:5173`, all `src/*` modules transform cleanly

## 🟡 Milestone 1 — Core Workflow (PARTIALLY DONE)

### Done in this session

- [x] `runRouter`: previewCreatable, create (aggregates approved sessions + emits `AttachedToRun`), startPurchase, purchaseItem, markUnavailable, startDelivery, deliverToStore, confirmStoreItem, confirmStore, finish, ejectSession
- [x] `runProjection`: inline projection of every run event into `read_model.market_runs_v` / `run_items_v` / `run_item_stores_v`, plus auto-insert into `inventory.price_history` on each `ItemPurchased`
- [x] `ApprovalPage`: queue list, atomic claim, approve, reject (with reason sheet), release-claim, expandable item view
- [x] `RunPage`: Stepper across plan/purchase/deliver/done; preview + create new run sheet; per-item Buy / N/A; per-store Deliver; Finish gate
- [x] `ConfirmPage`: per-item ok/short/wrong/quality chips, issue-detail sheet with note, Confirm Store button gated on all-decided
- [x] `Shell`: 5 tabs filtered by permissions, page switcher

### M1 punch list — landed in autonomous session 2026-05-01

- [x] **`order.sessionDetail({id})` endpoint** — ApprovalPage now uses it for the per-card item view.
- [x] **`PhotoCapture` component** — Tap-to-capture, downscale to 1280px, JPEG @ 0.85 → data URI. Wired into PurchaseSheet (receipt) and ConfirmPage's issue sheet. **S3 presigned URL flow is M2** — for now we ship base64 `data:` URIs; server schemas accept up to 300 KB.
- [x] **Multi-store split UI** — PurchaseSheet has a per-store qty allocator with live sum-vs-actual validation, supplier dropdown.
- [x] **Order pendingList enriched** — single query returns `storeName`, `memberDisplayName`, `memberAvatarUrl`, `itemCount`, `totalQty`. ApprovalPage cards no longer need 3 extra round-trips.
- [x] **`/debug` page** — Live ring buffer / Server logs / Health. Flush, Copy as JSON, Sign-out + reset.
- [x] **`PageMainButton` on RunPage / ConfirmPage** — progressive text ("Confirm store (3/5)"), guarded against empty-text crashes (`WebAppBottomButtonParamInvalid`).
- [x] **Toast component** — Top-of-screen, 4 tones, auto-dismiss + tap-to-dismiss. Replaces every `window.alert/prompt` we previously had.
- [x] **WebSocket realtime (basic)** — Bun.serve WS upgrade at `/ws?token=<jwt>`, in-process per-org `Hub`, order/run routers publish `*.changed` after each projection. Client `useRealtime` invalidates relevant TanStack Query keys with exponential reconnect.
- [x] **Offline command queue (basic)** — IDB outbox + `nextSeq` persistence + replay on `online` event. OrderPage's `adjust` opts in: network failure → enqueue, network back → replay in order. Drops on permanent server errors. Other mutations still fall through to plain error toasts (M2 work).
- [x] **Bot notification triggers** — `services/notify.ts` writes to `ops.notifications` + `sync.outbox`. Order router triggers on `Submitted` (→ approvers), `Approved` / `Rejected` (→ owner). Worker (`compass-worker.service`) drains every 5 s via grammY with exponential backoff.
- [x] **Domain run test suite** — `packages/domain/src/run/run.test.ts` ships 9 tests covering happy path / split-sum-mismatch / pending-items-block-delivery / store-not-confirmed / cancel-after-finished. Total 19/19 passing.

### M1 follow-ups landed in autonomous session 2026-05-01 (continued)

- [x] **Run notifications** — Run router now triggers on `RunPlanned`
  (→ purchasers), `StoreDelivered` (→ that store's staff, minus actor),
  `RunFinished` (→ original purchaser member). Wire mirrors order router
  via consolidated `services/notifyForEvent.ts`.
- [x] **Real S3 presigned upload** — `apps/api/src/services/s3.ts`
  (zero-dep SigV4 presigner), `upload` router with `requestPresign` +
  `config`, PhotoCapture wired to PUT directly to S3 / MinIO / R2 /
  Tencent COS. `domain.events.payload` no longer carries 1-2 MB base64
  blobs; falls back gracefully to data URI when bucket unconfigured.
- [x] **Offline replay extended** — `useOfflineQueue` map now covers
  RunPage's `purchaseItem` / `markUnavailable` / `deliverToStore` and
  ConfirmPage's `confirmStoreItem` / `confirmStore`. Centralized via
  `lib/networkError.ts` so the network-vs-domain classification has
  one definition + 6 unit tests pinning it.

- [x] **ApprovalPage history view** — `Pending / Approved / Rejected`
  ChipBar tabs above the list. Approved rows expose `Unapprove` (uses
  the existing `order.unapprove` endpoint); rejected rows show a
  danger Banner with the rejection reason.
- [x] **iPhone UX bug bash** — fixed qty +/- race (optimistic cache),
  removed duplicate Submit button (hide in-page when in Telegram),
  shrank top reserved strip 80→36 px, polished all page headers to
  share a consistent two-column rhythm, replaced emoji bottom-nav
  icons with monochrome SVG line-art, added native iOS momentum
  scrolling + overscroll-contain.
- [x] **Admin page is functional** — `apps/api/src/trpc/routers/admin.ts`
  with overview / memberList / storeList / roleList / grantRole /
  revokeRole; `apps/web/src/pages/AdminPage.tsx` with three tabs,
  `users.manage`-gated, RLS-scoped per org. Tap-a-role-chip-to-revoke
  uses `tg.showConfirm()` natively in Telegram.
- [x] **Admin: full CRUD across every entity** — Members /
  Stores / Categories / SKUs / Suppliers (each with create / edit /
  archive / unarchive). Members add status toggle (suspend /
  reactivate) + remove. Self-protection: cannot revoke own super_admin
  / admin role, cannot suspend or remove self.
- [x] **Admin: Audit log viewer** — last 100 domain events across
  the org's order + run streams. Read-only, surfaces actor + seq +
  type for every event.
- [x] **Debug merged into Admin as a sub-tab** — bottom nav back
  down to 5 tabs (was 6). Debug stays gated on `system.logs.view`
  via the Admin permission requirement.
- [x] **Qty flicker fix v2** — `useRealtime` debounces ws invalidates
  (400 ms quiet window) AND OrderPage drops `onSettled: invalidate`.
  Net: +/- taps update the cache instantly via optimistic write,
  reconciliation happens once after the burst settles, no flicker.
- [x] **Review-before-submit sheet** — MainButton tap opens a sheet
  showing per-category SKU/qty preview. "Confirm and submit" is the
  actual mutation trigger; "Keep editing" is a no-op cancel.

### Still on M1 punch list (NOT done)

- [ ] **Concord components left to ship**: `Combobox`, `DatePicker`, `Stat`, `Tabs`. (`Toast` + `ChipBar`-as-tabs shipped; `Stat` is inline in AdminPage and could be promoted.)
- [ ] **`@trpc/server` v11 subscription link** — would replace the home-grown WS layer with first-class tRPC subscriptions; nice-to-have, not blocking.
- [ ] **WebPush channel** — outbox accepts `webpush` rows but the worker treats them as no-op (marks sent + `lastError: 'webpush not implemented (M2)'`). Pulled in alongside VAPID setup in M2 — needs `web-push` lib + VAPID keys + service worker + `web_push_subscriptions` table.

### Not yet implemented from architecture

- [ ] **OpenTelemetry full chain** (trace from FE click → API → DB query) — client buffer exists; no OTLP exporter wired.
- [ ] **Loki + Grafana compose** — listed in `infra/grafana/` but the dashboards JSON isn't authored yet.

## 🔵 Milestone 2 — Intelligence (NOT STARTED)

- [ ] **Historical-mean suggestions**: nightly worker computes per-(store, sku, day-of-week) median, writes `inventory.skus.suggested_qty`. UI shows in `OrderPage` row.
- [ ] **Price anomaly detection**: nightly worker computes z-score over 30-day window per (sku, supplier); breaches write to `notifications` for super_admin.
- [ ] **Supplier auto-scoring**: weekly worker recomputes `reliabilityScore` (cancellations, missed dates) + `priceTrustScore` (variance from market median).
- [ ] **Excel reports**: `report.dailySummary` mutation generates xlsx via `exceljs`, uploads to S3, writes `excelUrl` on a `daily_reports` row.
- [ ] **Dashboard page**: KPI cards (total spend, runs, fill rate, avg cycle time), price-trend mini-charts.
- [ ] **`PriceHistoryPage`**: 30/90/365-day chart per SKU; powered by `inventory.price_history` + downsampling on the API side.

## 🟣 Milestone 3 — Hardening (NOT STARTED)

- [ ] **WebAuthn for admin/super_admin**: Required second factor for `users.manage` and `system.impersonate`.
- [ ] **Full RLS test suite**: `tests/integration/rls.test.ts` with 2-org fixtures; every API route asserted to return 0 rows under wrong org context.
- [ ] **CSP via `@fastify/helmet` equivalent for Hono**: tuned for Telegram WebView.
- [ ] **Per-route rate limits**: `order.adjustItem` 600/min/user, others 100/min.
- [ ] **Sentry + structured pino**: error reporting wired to a Sentry DSN + log shipping to Loki.
- [ ] **Backup recovery drill**: monthly cron (`infra/scripts/restore-to-staging.sh`) restores last night's `pg_basebackup` to a staging PG and runs the smoke suite.
- [ ] **Blue-green deploy**: `compass deploy` script.
- [ ] **CI** — extend `.github/workflows/ci.yml` (M1.9 minimum-viable type-check + unit + parity gates) with: PG-backed integration tests via `services.postgres`, Playwright browser smoke against an ephemeral preview, eslint, build + deploy automation. Today CI gates types + unit + i18n parity + migration journal only.

## 🔴 Milestone 4 — Production launch (NOT STARTED)

- [ ] Real Telegram bot token + webhook setup
- [ ] First production org provisioning
- [ ] On-call rotation + status page
- [ ] Load test baselines (k6) for the 3 hot routes
- [ ] First user training session

---

## Known bugs surfaced during this session

| # | Where | Fix |
|---|---|---|
| 1 | drizzle-kit can't resolve `.js` suffix imports | Stripped `.js` from all relative imports in `packages/db/src` (and later across all packages, since Bun is happy either way and Vite resolves `.ts` directly) |
| 2 | PowerShell `Set-Content` mangled CJK seed strings | Rewrote `seed.ts` via Write tool (UTF-8 BOM-less) |
| 3 | Host PostgreSQL 18 occupied port 5432 | Compose now publishes PG on 5433, Redis on 6380; `.env` matched |
| 4 | RLS policy referenced `org_id` column on `auth.member_role_bindings` (which doesn't have it) | Moved to FK-piggyback policy via `auth.roles.org_id` |
| 5 | `@hono/node-server` silently drops connections on Bun | Switched to native `Bun.serve({ fetch: app.fetch })` |
| 6 | `@hono/trpc-server` v0.3.4 calls `createContext(opts, c)`, not `createContext({ c })` | Fixed signature |
| 7 | `@trpc/server/observable` removed in v11 | Dropped custom `tracingLink` for M0; restore in M1 with v11's subscription transport |
| 8 | Tailwind v4 needs `@tailwindcss/postcss` separately | Added to `apps/web/devDependencies` |
| 9 | `JWT_REFRESH_SECRET` placeholder shorter than 32 chars | Updated `.env.example` and `.env` |
| 10 | API didn't auto-load workspace-root `.env` | All processes (api, db, cli) now have a small `loadRootEnv()` walking up from their cwd |
| 11 | `cli/package.json` missed `drizzle-orm` peer | Added direct dep |

## How to keep going

```bash
# A. Make a code change
pnpm dev                       # both API and Web hot-reload

# B. Add a domain rule
# 1) Add the case to packages/domain/src/<aggregate>/commands.ts
# 2) Update apply() in state.ts
# 3) Update the projector in apps/api/src/services/<aggregate>Projection.ts
# 4) Add a Zod schema in packages/contracts/src/schemas/<aggregate>.ts
# 5) Wire a tRPC endpoint in apps/api/src/trpc/routers/<aggregate>.ts
# 6) Update docs/EVENT_CATALOG.md
# 7) Add a test in packages/domain/src/<aggregate>/<aggregate>.test.ts

# C. Schema change
pnpm db:generate               # produces a new SQL file in packages/db/migrations
# review the generated SQL, edit RLS in packages/db/migrations/sql/ if needed
pnpm db:migrate                # idempotent

# D. Grant another user
pnpm compass user grant <tgUserId> --role staff --org default
```
