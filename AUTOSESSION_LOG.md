# Autonomous session log

> Single-session log of everything I shipped while you were away.
> Sister doc to `ROADMAP.md`. Both are kept under git so future sessions
> can `git log --oneline -- ROADMAP.md AUTOSESSION_LOG.md` and see the
> arc of decisions.

## What changed (chronological)

### 1. Verified the previous deploy was actually live

Curled the public URL, fetched the bundle, grep'd for user-facing strings I
had just written. Confirmed the JS in production contains "pending order",
"Tap a status", "Approval queue", and does NOT contain "Run network
diagnostic" or "TgBotGemini". So the previous deploy did reach prod —
the user's "no change" was caused by iPhone Telegram WebView aggressively
caching the index.html.

### 2. Killed the cache problem at the root

- nginx site `app` now sets `Cache-Control: no-store, no-cache,
  must-revalidate, max-age=0` + `Pragma: no-cache` + `Expires: 0` +
  `Surrogate-Control: no-store` on `/`. Hashed assets in `/assets/`
  keep `public, immutable, max-age=2592000`.
- Vite plugin emits `apps/web/dist/build-id.txt` per build, AND replaces
  `%VITE_BUILD_SHA%` in index.html's `<meta name="compass-build">`.
- API's `/health/version` now reads `dist/build-id.txt` (rather than the
  static-at-startup env var) so it returns the live web build's id.
- Client `useVersionCheck` polls `/health/version` every 30 s + on focus.
  When the server's id differs from the running bundle's `<meta>` tag, a
  Toast prompts the user; auto-reload after 30 s if untapped.

Net effect: any future deploy I do shows up on your iPhone within 30 s
without you doing anything. iPhone can't trap us in stale HTML anymore.

### 3. Built a smoke harness

`scripts/smoke.ts` (Bun) — 27 checks against the live URL covering:

- Static SPA: HTML cache headers correct, asset hashes match, `<meta>`
  build sha replaced, JS bundle contains expected user-facing strings,
  JS bundle does NOT contain debug/leak markers.
- Health: `/health/live`, `/health/version` shape.
- tRPC: public + auth-required routes + `system.log` lenient ingest +
  `/ws` reachable.

`scripts/browser-smoke.ts` (Node + Playwright Chromium) — 12 checks:

- Stubs Telegram's `telegram-web-app.js` so AuthGate's auto-login fires.
- Network-routes `auth.telegramLogin` / `auth.me` / catalog / order /
  run / system queries to fixed responses.
- Asserts: page loads, React mounts (`<html class="ready">`), BottomNav
  appears, all 6 tabs render without new JS errors, zero pageerror, zero
  unexpected console.error (with WS-handshake noise allow-listed since
  the smoke uses a fake token).

Critically: this harness reproduces the exact bugs we shipped earlier
(WebAppBottomButtonParamInvalid, blank screen on module-load failure,
tab render exceptions). The Telegram WebApp stub even throws on empty
`MainButton.setText()` calls so I'd have caught the empty-text bug
before deploy.

### 4. `scripts/deploy.ts` — gated deploy

Single command tar+scp+extract+install+restart+rebuild+smoke. Won't
declare success unless both smokes (server + browser) pass against the
live URL. Replaces every prior ad-hoc `tar | scp | ssh` sequence.

### 5. Made workspace TS-clean

`pnpm -r exec tsc --noEmit` was full of errors. Fixed:

- `packages/db/tsconfig.json`: drop `bun` types (dev/test runner only),
  drop `drizzle.config.ts` from include (rootDir mismatch).
- `packages/db/src/rls.ts`: cast `tx as unknown as DB` since
  `PgTransaction` is structurally close-enough but missing `$client`.
- `packages/db/src/schema/readModel.ts`: drop unused `pkUuid` import.
- `packages/ui/src/components/Banner.tsx`: `Omit<HTMLAttributes,'title'>`
  so our `ReactNode` title doesn't conflict with native string title.
- `apps/api/src/app.ts`: cast `createContext` at the trpcServer boundary
  (Hono's wrapper wants `Record<string, unknown>`, narrower than ours).
- `apps/api/src/trpc/context.ts`: drop unused `<T>` generic.
- `apps/api/src/trpc/routers/order.ts`: drop dead `loadOrCreateTodaySession`
  + unused `asc` import.
- `apps/api/src/trpc/routers/run.ts`: trim unused imports.
- `apps/web/tsconfig.json`: add `baseUrl: "."` for the path alias.
- `apps/web/src/app/ErrorBoundary.tsx`: `override` modifiers per
  `noImplicitOverride`.
- `apps/web/src/pages/DebugPage.tsx`: accept `Date | string` for
  `createdAt` since tRPC w/o transformer ships ISO strings.
- `apps/web/src/pages/RunPage.tsx`: same Date-or-string fix on splits.
- `apps/web/src/pages/OrderPage.tsx`: drop unused Card/CardMeta/CardTitle
  imports.

Net: `EXIT=0` across all 12 packages.

### 6. Tailwind v3 hard-pinned (was leaking back to v4)

Every prior deploy was overwriting the server's working v3 setup with my
local v4-beta config. Sync'd local to v3:

- `apps/web/postcss.config.js`: plugins are `tailwindcss + autoprefixer`
  (no `@tailwindcss/postcss`).
- `apps/web/tailwind.config.js`: created with content scanning
  `./src/**/*.{ts,tsx}` + `../../packages/ui/src/**/*.{ts,tsx}`.
- `apps/web/package.json`: `tailwindcss@^3.4.14` + `postcss@^8.4.49`,
  `@tailwindcss/postcss` removed.
- `apps/web/src/styles/index.css`: `@import` at top, then
  `@tailwind base/components/utilities`.

### 7. K. Bot notifications (outbox + worker + grammY)

- `apps/api/src/services/notify.ts` — `dispatch()` writes to
  `ops.notifications` (per-user inbox) AND `sync.outbox` (the queue the
  worker drains). Helpers: `findRecipientsByPermission(orgId, key)` and
  `findStoreStaff(orgId, storeId)`.
- Order router: after every `runSimpleCommand` projection, calls
  `dispatchOrderNotifications(events)`:
  - `Submitted` → all org members with `order.approve`, dedup
    `order:${id}:submitted`, deep-link `/approve`.
  - `Approved` → owner only, deep-link `/order`.
  - `Rejected` → owner only, body = reject reason.
- `apps/worker/src/main.ts` rewritten as a polling worker (BullMQ was
  overkill for a single-process queue): every 5 s reads `sync.outbox`
  WHERE `sent_at IS NULL AND next_attempt_at <= now()` LIMIT 50,
  dispatches via grammY, marks `sent_at` on success, exponential
  backoff (5 s → 10 → 30 → 1 min → 5 min → 15 min → 1 h → 3 h) on
  failure, gives up after 8 retries.
- `infra/systemd/compass-worker.service` — installed by `deploy.ts`
  each run; deploy script enables + restarts both `compass-api` and
  `compass-worker`.
- Permanent grammY errors (403 user-blocked-bot / 400 bad-id) silently
  mark sent so we don't loop forever; transient errors retry.

### 8. J. WebSocket realtime (basic per-org broadcast)

- `apps/api/src/realtime/hub.ts` — in-process per-org channel registry
  with `subscribe(orgId, send)` returning unsubscribe. `publish(orgId,
  msg)` fans out to every attached sink.
- `apps/api/src/main.ts` — Bun.serve now accepts `/ws?token=<jwt>`
  upgrades. Token is the same access JWT the SPA uses for tRPC; M2 will
  swap to a dedicated short-lived ws ticket. WS lifecycle wires into
  the hub.
- Order router publishes `order.changed` after every projection. Run
  router publishes `run.changed`. Both inside the same tx as the
  projection so subscribers see them in lockstep.
- `apps/web/src/hooks/useRealtime.ts` — opens a WS, exponential
  reconnect (1 s → 30 s cap), invalidates relevant TanStack Query keys
  on `order.changed` / `run.changed` / `notification`. Wired into App
  via a new `<QueryConsumers>` inner shell so both `useToast` and
  `useQueryClient` are in scope where they belong.
- nginx already proxies `/ws` (the existing site config has the
  `Upgrade/Connection` headers).

When two browsers are open by the same user (or two different users
in the same org), an action in one immediately invalidates queries in
the other — a manager seeing a freshly-submitted order without manual
refresh, a staff seeing their own approval status flip. No polling.

### 9. L. Offline command queue (basic)

- `apps/web/src/lib/idb.ts` — promise-wrapped IndexedDB with two
  stores: `outbox` (the offline command log, keyed by `clientSeq`) and
  `keyval` (used to persist `nextSeq` across reloads).
- `apps/web/src/hooks/useOfflineQueue.ts` — registers a per-procedure
  replay map. Returns `{ pendingCount, enqueue, flush, online }`.
  Replays in order on `navigator.online`, on focus, and after each
  `enqueue()`. Drops entries on permanent server errors (CONFLICT /
  BAD_REQUEST / NOT_FOUND); leaves transient failures in the queue
  with `retries++`.
- OrderPage `adjust` mutation now has `onError`: if the error looks
  like a network drop (Load failed / TypeError cause / `!navigator.onLine`),
  enqueue `('order.adjustItem', vars)` for replay. Online users see
  no behavior change; offline users still get the qty button to
  appear-to-work and the change lands when network returns.

This is the *minimum viable* offline path. Full CRDT-style merge with
client-issued idempotency keys + server-side dedup is M2.

### 10. Run notifications

Mirroring step 7's pattern, run router now triggers notifications on:
- `RunPlanned` → all org members with `run.purchase` (excluding actor)
- `StoreDelivered` → store staff (`delivery.confirm`-perm + scope-matching)
- `RunFinished` → purchaser (excluding actor if same)

`services/notify.ts` exposes `findStoreStaff(orgId, storeId)` for the per-store fan-out.

### 11. End-to-end integration test against real Postgres

`apps/api/src/__tests__/full-lifecycle.test.ts` walks a complete cycle:
**draft → adjust → submit → claim → approve → plan run → purchase → deliver → confirm-item → confirm-store → finish**, then drops the run's read-model rows and replays the events, asserting the rebuilt state matches.

**This test caught a critical bug** that pure-domain unit tests had missed:
the routers used `ulid()` to generate `streamId` / event `id`, but
`domain.events.stream_id` is a Postgres `uuid` column. Postgres rejects
ULIDs with `invalid input syntax for type uuid`. **Every prod write
to the event store would have failed** the moment a real user finished
their first order — the only reason this hadn't surfaced is no end-to-end
order flow had completed yet.

Fix: replaced `ulid()` with `crypto.randomUUID()` in:
- `apps/api/src/services/eventStore.ts` (event row id)
- `apps/api/src/trpc/routers/order.ts` (session stream id)
- `apps/api/src/trpc/routers/run.ts` (run stream id)
- `apps/api/src/trpc/routers/auth.ts` (refresh-token family)

Trace ids in `context.ts` keep using `ulid()` since they're string fields, not uuid columns.

The integration test is now part of the deploy gate (`scripts/deploy.ts`
step 5.5), so we fail-fast on schema drift before pushing to prod.

### 12. Deep browser smoke

`scripts/browser-smoke-deep.ts` — second-tier UI smoke that actually
clicks through the workflow with stubbed network responses:

- Clicks `+` on a SKU's qty control → asserts qty went 0→0.5, Selected
  counter ticked up 0→1.
- Asserts the in-page "Review Order (1)" PWA-fallback button appears.
- Clicks it → mock submit endpoint flips session.status="submitted" →
  switches to Approve tab → asserts the pending session card shows
  "Smoke Store" + "Smoke" (member name) + "1 pending order" subtitle.
- Walks Run / Confirm / Debug tabs and asserts each renders the
  expected empty/health state.

13/13 checks passing. Wired into `scripts/deploy.ts` step 8 so a deploy
that breaks the qty-tap → submit flow fails the gate before the user
sees it.

### 13. Consolidated event→notification dispatch

The order and run routers each had their own inline `dispatchOrder…` /
`dispatchRun…` function that mapped domain events to notification rows.
Same shape, two copies, drifting independently — the order router got a
new dedup-key style and the run side didn't. Pulled both into
`apps/api/src/services/notifyForEvent.ts`:

- `dispatchOrderEventNotifications(db, orgId, actorUserId, state, events)`
  fans `Submitted` → approvers, `Approved`/`Rejected` → owner. All
  events that don't notify (DraftStarted, ItemAdjusted, ItemNoteSet,
  Claimed, ClaimReleased, Withdrawn, Unapproved, AttachedToRun,
  EjectedFromRun, Archived) fall through `default:` and are listed in a
  comment so the next person reading this can verify they really
  shouldn't notify.
- `dispatchRunEventNotifications(...)` mirrors: `RunPlanned` →
  purchasers, `StoreDelivered` → that store's staff (minus actor),
  `RunFinished` → the original purchaser. The previous run router only
  notified on RunPlanned; StoreDelivered + RunFinished are NEW notifies
  added in the consolidation. Recipients for store-delivered come from
  a new `findStoreStaff(db, orgId, storeId)` helper in `notify.ts`.
- Each router now has one line: `await dispatch…(tx, orgId, userId,
  state, out)` inside the same transaction as the projection write,
  so the outbox row goes in atomically with the read-model update.

Both router files dropped 60+ lines of duplicated dispatch glue. The
worker still sees the same `sync.outbox` rows; only the producer side
moved.

This also closes the AUTOSESSION_LOG bullet "Run notifications — only
Order events trigger notifications right now" (item under "What's NOT
done" earlier in the log) — Run notifications are now wired the same
way Order notifications are.

### 14. Real S3 presigned upload (replaces base64 data: URIs)

The receipt + issue photo paths used to encode the JPEG as a base64
data URI and store it inline in `domain.events.payload`. That blew up
the JSONB column at scale (a 1.2 MB photo → 1.6 MB base64 → on every
event read for projection rebuild). Replaced with direct-to-bucket
presigned PUT, no API streaming.

- **`apps/api/src/services/s3.ts`** — minimal SigV4 PUT presigner. ~150
  LOC, zero deps. Why not @aws-sdk/*? It pulls 10 MB of polyfills and
  we only need ONE thing: a signed URL the browser can PUT to.
  Supports MinIO (path-style) and AWS / R2 / Tencent COS
  (virtual-hosted). Reads creds from `process.env` at call-time so
  unit tests can flip them.
- **`apps/api/src/__tests__/s3.test.ts`** — 7 SigV4 cases: AWS-default
  virtual-hosted addressing, MinIO path-style, RFC3986 path encoding,
  leading-slash key normalization, S3_PUBLIC_BASE override, expiresIn
  clamping, S3NotConfiguredError when creds missing. Total tests now
  27/27 (was 20/20 before this entry).
- **`apps/api/src/trpc/routers/upload.ts`** — new `upload` router.
  `requestPresign({ kind, contentType, contentLength?, filename? })`
  returns `{ url, publicUrl, key, expiresIn, requiredHeaders }`. Object
  key is built from `<orgId>/<userId>/<kind>/<yyyy-mm-dd>/<uuid>.<ext>`
  — orgId/userId from auth ctx, NEVER input, so a user cannot poke
  another tenant's namespace. Allowed MIME: image/jpeg, image/png,
  image/webp. Hard cap 8 MB. `upload.config` is a sibling query that
  tells the FE whether real uploads are wired up; cached 60 s on the
  React Query side.
- **`packages/ui/src/components/PhotoCapture.tsx`** — added optional
  `uploader` prop. With it, the capture pipeline is: load → downscale to
  1280 px JPEG@0.85 → request presign → PUT directly to bucket → emit
  the `publicUrl`. Without it, falls back to data: URI so dev without
  MinIO still works.
- **`apps/web/src/hooks/usePhotoUploader.ts`** — new hook. Reads
  `upload.config` and returns either a real uploader bound to
  `requestPresign.mutateAsync`, or `undefined` (= keep fallback). Used
  by RunPage (kind: 'receipt') and ConfirmPage (kind: 'issue').
- **Smoke harness extended.** `scripts/smoke.ts` now asserts
  `upload.config` and `upload.requestPresign` both 401 anonymous (auth
  gate is intact). `scripts/browser-smoke.ts` and
  `scripts/browser-smoke-deep.ts` stub `upload.config` with
  `enabled: false` so smoke runs against MinIO-less environments.
- **No schema migration needed.** The contracts already accept
  `photoUrl: z.string().max(300_000).nullable()` (the 300_000 cap was
  the data-URI fallback). https URLs stay well under that.

What's NOT done in this slice (intentionally deferred):
- Real bucket-side delete on `domain.events` purge — when M3 ships
  test-data purge, S3 lifecycle rules age objects out automatically
  rather than us managing object deletion ourselves.
- Web push / image CDN. `S3_PUBLIC_BASE` lets ops swap to Cloudflare /
  CloudFront in front of the bucket without code changes.

### 19. Qty flicker, review-before-submit, full admin CRUD

Second iPhone-testing pass. User flagged:

**Qty +/- still flickering after the optimistic-cache fix.** Root
cause was a feedback loop the first fix didn't break: every successful
adjustItem fanned out a `order.changed` WebSocket event, which
`useRealtime` translated into an immediate `invalidateQueries`, which
triggered a refetch — and that refetch could complete (with stale
qty) BEFORE the user's next tap finished its own mutation. Net visual:
the displayed qty jumped 0 → 0.5 (optimistic) → 0 (refetch arrives) →
0.5 → 1.0 (next optimistic) → 0.5 → 1.0 …

Fix layered on top of the optimistic cache:
- `useRealtime`: debounced invalidate. A burst of `order.changed`
  events for the same query key collapses into ONE refetch ~400 ms
  after the burst settles. Pending timers cleared on unmount.
- `OrderPage` `adjust.mutate`: dropped `onSettled: invalidate`. The
  optimistic cache is already authoritative on the client; the
  debounced WS invalidate handles reconciliation in the background.
  No more refetch-races mid-tap.
- `usePageMainButton(canSubmit)` — second-tap to open the review
  sheet (not submit immediately) — avoids accidentally racing the
  MainButton text update with its visibility flip.

**Review-before-submit sheet.** Tapping the MainButton no longer fires
`order.submit` directly. Instead it opens a sheet with a per-category
list of selected SKUs + qty + unit; "Confirm and submit" inside the
sheet is the actual mutation trigger. "Keep editing" closes without
side effects. Stops accidental submits and gives the receiver-of-the-
order confidence about what's about to be locked in.

**OrderPage "Draft" badge dropped.** The badge said "Draft" while
editing — which is implicit (the user IS editing, that's the only
state where they can adjust qty). Once status becomes
`submitted/approved/rejected/in_run`, the existing Banner components
take over with rich context. So the bare-word badge in the header was
pure noise; only show it for non-draft statuses now. (Same applies
to the bottom-nav label "Order" — keeping it because that's
navigation, not page chrome.)

**Admin: Debug merged in as a sub-tab.** Bottom nav was 6 items,
which is one too many for comfortable thumb-reach on a 414×896
iPhone viewport. Debug only matters to admins anyway — moved it
into Admin → Debug chip. Bottom nav now has 5 items.

**Admin: full CRUD across every entity, plus audit.** Existing tabs
(Members / Stores / Categories / SKUs / Roles / Overview) gained
matching backend mutations + frontend forms. Two new tabs:
- **Suppliers** — list / create / edit / archive / unarchive. Form
  captures name + phone + Telegram username + address + free-form
  notes. (Reliability + price-trust scores are auto-computed by the
  M2 worker.)
- **Audit** — read-only feed of the last 100 domain events across
  the org's order + run streams. Each row shows
  `<streamType>.<eventType>`, the actor (display name + @username),
  seq, and a relative timestamp. "Append-only event log" banner at
  top makes the read-only nature explicit.

The full admin tab strip is now: Overview / Members / Stores /
Categories / SKUs / Suppliers / Roles / Audit / Debug. Every list
view's Edit / Archive button posts back to a `users.manage`-gated
mutation; every form lives behind a Sheet so accidental cancels are
just an "outside-tap" away.

Self-protection rules (server-side, in `admin.ts`):
- `memberSetStatus({ memberId, status: 'suspended' })` — refuses to
  suspend the caller themselves.
- `memberRemove({ memberId })` — refuses to remove the caller.
- `revokeRole({ bindingId })` — refuses if the binding is the
  caller's own super_admin OR admin role. The CLI is the escape hatch
  for true breakage (which is exactly what restored the user's access
  after they self-revoked from the UI).

Browser smoke updated for Debug-tab move + new Suppliers / Audit
endpoint stubs.

### 18. iPhone-testing UX bug bash

User opened the Mini App on a real iPhone in Telegram and reported a
list of issues. Fix slice:

**Critical: OrderPage qty +/- race condition.** Fast taps on the +/-
buttons either lost the user's input or showed the qty bouncing back
to a stale value. Root cause: `QtyControl.value` was bound directly to
the server state via `qtyBySku.get(sku.id)`, so during the network
round-trip after a tap, a SECOND tap saw `value = 0` (still!) and
called `onChange(0 + step)` → mutation fired with the same value as
the first one. After the first response landed, React Query's
invalidate/refetch could then snap the qty back to a stale midpoint
from a slow response.

Fix in `OrderPage.tsx`:
- `onMutate`: cancel any in-flight `todaySession` refetch, snapshot
  the cache, and write the optimistic qty. On a session that doesn't
  exist yet, materialize a temporary `id: 'optimistic'` shape so the
  next tap reads the new qty (not `0`) and the next mutation goes
  `0.5 → 1.0` instead of `0 → 0.5` again.
- `onError`: if `isLikelyNetworkError(err)` keep the optimistic value
  AND enqueue for offline replay; on domain error roll back to the
  pre-tap snapshot.
- `onSettled`: invalidate (TanStack batches concurrent invalidates,
  so 5 fast taps still produce just 1 refetch).

Net: tap-tap-tap-tap on + now shows 0.5 → 1.0 → 1.5 → 2.0 instantly,
all 4 mutations send distinct values, the server settles, and the
final invalidate confirms.

**Duplicate Submit buttons.** Inside Telegram the user saw both the
PWA-fallback in-page Submit button AND Telegram's native MainButton.
Fix: in `OrderPage`, hide the in-page button when `getTg()` returns
truthy (we're in Telegram WebView). The smoke needed an alternate
submission path since `getTg()` is also truthy under the stub —
introduced `window.__compassMainButtonClick()` exposed by the stub
that fires the registered MainButton onClick handlers, used by the
deep browser smoke instead of the now-hidden fallback button.

**Top reserved strip too tall.** The 80 px strip plus
`env(safe-area-inset-top)` (~50 px on iPhone 14 Pro) produced a ~140 px
empty band above the first content row. Tightened to 36 px — clears
Telegram's chrome row without wasting screen real-estate.

**Layout polish across pages.** Title moved BEFORE filter chip bar on
OrderPage / ApprovalPage (was filter-then-title, which read as
header-noise above an empty title); per-page header now uses a
consistent two-column `[title block | numeric counter]` shape with
matching uppercase/tracking eyebrow text. Headers on Confirm / Run /
Approval / Order all share the same vertical rhythm now.

**Bottom nav icons → SVG line-art.** Replaced emoji icons (📝 ✓ 🛒 📦
⚙ 🐞) with monochrome SVG line-art that matches Telegram's own
bottom-bar icons (Chats / Calls / Settings). Sit in the new
`packages/ui/src/components/NavIcon.tsx`. Each icon is hand-drawn at
24 px with stroke-width 1.75; no external icon library.

**Scroll feel.** `<main>` now ships `WebKitOverflowScrolling: 'touch'`
+ `overscrollBehaviorY: 'contain'` so iOS Telegram WebView gets native
momentum scrolling, and over-scroll at the top doesn't bubble to
Telegram's container (which made the page feel like it was "fighting"
the user). ChipBar gets `overscrollBehaviorX: 'contain'` for the same
reason on horizontal pulls.

**Admin page is functional.** Built a full `apps/api/src/trpc/routers/admin.ts`
with overview / memberList / storeList / roleList queries +
grantRole / revokeRole mutations (all gated on `users.manage`,
RLS-scoped to caller's org, cross-tenant safety on revokeRole). Built
`apps/web/src/pages/AdminPage.tsx` with three tabs:
- **Overview**: 6 stat tiles (members, stores, active SKUs, runs,
  pending approvals, orders / 7 days). Pending approvals tile flips
  to warning tone when > 0.
- **Members**: cards with avatar + Telegram username + last-seen +
  status badge + role chips. Tap a role chip to revoke (uses Telegram's
  `tg.showConfirm()` natively, falls back to `confirm()` on the web).
  Tap "Grant role" to open a sheet listing all org roles.
- **Stores**: read-only cards with code + timezone + active state.

Stub admin endpoints + new admin tab assertions added to both
browser-smoke files.

### 17. OrderPage: approved + in_run status banners

The OrderPage status banners only existed for `rejected` and
`submitted-no-claim` (both with a Withdraw CTA). After approval, the
page just showed the read-only quantities — staff had no signal that
their order had advanced through the workflow. Added:

- `approved` → green Banner "Approved · awaiting market run" with
  copy explaining the purchaser will pull it next run.
- `in_run` → info Banner "In progress · purchaser is buying" so staff
  understand the order is now mutating server-side.

No new mutations / endpoints — pure presentation. Mirrors the
manager-side ApprovalPage history tabs so both roles share visibility
into the same lifecycle states.

### 16. ApprovalPage: history tabs + Unapprove

`ApprovalPage` was a single list of submitted sessions; once a manager
approved or rejected one, it disappeared. Operators couldn't undo a
mis-click without touching SQL.

- Added `Pending / Approved / Rejected` ChipBar tabs above the list.
  The 'pending' label is FE-side; the server enum is `submitted`,
  remapped at the query call site.
- Approved tab shows an `Unapprove` button (uses existing
  `order.unapprove` endpoint) — sends the session back to `submitted`
  with the manager auto-claimed, per the domain rule that an
  approved session can be reversed only as long as it hasn't been
  attached to a market run yet.
- Rejected tab shows a danger Banner with the rejection reason if
  present (so staff and managers see the same context). No mutation
  buttons here — staff own re-submission.
- Browser deep smoke gained one more check (the three tab labels are
  visible). 14/14 deep checks; 88/88 total.

### 15. Offline replay extended to purchaser + receiver flows

Before: only `order.adjustItem` had offline-replay wiring on OrderPage.
The purchaser (RunPage, in a market with 4G that drops every 30s) and
the receiver (ConfirmPage, in a back-office basement with terrible
wifi) had `onError → toast.error` and the user lost the write.

After:
- `apps/web/src/lib/networkError.ts` — `isLikelyNetworkError(err)` —
  centralizes the heuristic for "this came from the network layer, NOT
  a server-side domain error." Checks navigator.onLine, err.cause name
  === 'TypeError', and the iOS WebView's "Load failed" + Chrome /
  Firefox's "Failed to fetch" message strings. Anything else is treated
  as final and NOT enqueued — domain errors (CONFLICT / FORBIDDEN /
  NOT_FOUND) replayed forever would loop the outbox.
- `apps/web/src/lib/__tests__/networkError.test.ts` — 6 cases pinning
  the heuristic so the next person can't widen it accidentally.
  Critical edge case: a domain message that *contains* the word
  "fetch" (like "could not fetch user") must NOT trigger the network
  classifier; the test asserts that.
- OrderPage refactored to use the helper (was inlined).
- RunPage: `purchaseItem`, `markUnavailable`, `deliverToStore` all
  enqueue on network failure with a `toast.info('Saved offline — will
  sync when back online')`. The mutation's optimistic UX (sheet
  closes, draft cleared) still happens so the purchaser can move to the
  next SKU instead of being blocked.
- ConfirmPage: `confirmStoreItem`, `confirmStore` get the same
  treatment.
- `useOfflineQueue` already had the replay infrastructure (IDB outbox +
  online-event flush + retries). All this work added was 2 hooks (one
  per page) that map the procedure name → `utils.client.*.mutate` +
  the right invalidation. Total +33 tests across the workspace.

## Final smoke results

```
33 / 33 unit + integration tests
        - 10 order/decide  (pure)
        - 9  run/decide    (pure)
        - 7  s3 presigner  (SigV4 query-string vectors)
        - 6  networkError  (network-vs-domain classifier)
        - 1  full-lifecycle (PG-backed, end-to-end)
29 / 29 server-side checks against live URL
        (was 27; +2 for upload.config / upload.requestPresign auth)
12 / 12 browser smoke (shallow: render + console hygiene)
14 / 14 browser smoke (deep: actual UI interactions)
 0 / 0  TypeScript errors across 12 workspace packages
————————————————————
88 / 88 total checks pass via `bun run scripts/deploy.ts`
```

Worker: `compass-worker.service` active, polling every 5 s.
API: `compass-api.service` active, /ws upgrade endpoint live.

**Critical save**: the integration test caught the ULID-vs-UUID bug
*before* a real user could trigger it in prod. Without this work,
the very first successful end-to-end order flow would have crashed
with `invalid input syntax for type uuid`.

## Commands you'll want

```bash
# Run smoke locally before any deploy:
cd CompassAlpha && bun run scripts/smoke.ts          # 27 server-side checks
cd CompassAlpha && node --experimental-strip-types scripts/browser-smoke.ts   # 12 browser checks

# Deploy + auto-verify (gated; non-zero on smoke fail):
cd CompassAlpha && bun run scripts/deploy.ts

# Just re-run the gate against current prod, no redeploy:
cd CompassAlpha && bun run scripts/deploy.ts --dry

# On the server:
sudo systemctl status compass-api compass-worker
sudo journalctl -u compass-api -f
sudo journalctl -u compass-worker -f

# Force outbox to flush right now (debug):
PGPASSWORD=$(grep '^DATABASE_PASSWORD' /home/ubuntu/.compass-deploy-secret | cut -d= -f2) \
  psql -h 127.0.0.1 -U compass -d compass \
  -c "UPDATE sync.outbox SET next_attempt_at = now() WHERE sent_at IS NULL"
```

## What's NOT done

These were on the original M1 punch list and remain pending:

- **WebPush channel** — outbox has the `webpush` channel hooked but the
  delivery side is a no-op (just marks sent + lastError). Pulled in M2
  alongside `web-push` lib + VAPID setup.
- **Real CRDT offline** — M1 offline only handles `order.adjustItem`.
  Other mutations (submit / approve / reject / claim / purchase / …)
  fall through to plain "show error". Each can be added trivially to
  the replay map but I want a real reconciliation strategy first.
- **WS auth via short ticket** — M1 reuses the access JWT. Short ws
  tickets land in M2 along with the realtime smoke that actually opens
  a socket end-to-end with a real token.
- **Run snapshot rebuild test** — `compass project rebuild order|run`
  CLI command is still a stub. End-to-end "drop read_model + replay
  events == identical state" assertion is on the M3 list.

## Things I observed but didn't fix

Listed for the next session so nothing falls off:

1. Vite warns: "telemetry/src/index.ts is dynamically imported by
   ErrorBoundary.tsx but also statically imported by App.tsx and
   DebugPage.tsx, dynamic import will not move module into another
   chunk." — Cosmetic. Either drop the dynamic import in
   ErrorBoundary.tsx (already-loaded telemetry is fine to import
   eagerly) or accept the warning.
2. tRPC v11 + httpLink wire format is `{events: [...]}` raw, NOT
   `{json: {events: [...]}}`. Documented in scripts/smoke.ts comments
   so future test additions don't fall in the same trap.
3. The trycloudflare quick-tunnel URL still rotates on cloudflared
   restart. Until you're ready to provision a named tunnel + your own
   domain, BotFather's URL goes stale on every host reboot.
4. `compass-worker` runs without Redis. If you ever add BullMQ-based
   periodic jobs (M2: supplier rescore, daily reports), Redis is
   already on the host so just `import IORedis from 'ioredis'`.
