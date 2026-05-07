# Contributing to CompassAlpha

Welcome. This doc captures the conventions a new dev needs to be productive
without pinging the founder. Read [README.md](./README.md) first for setup;
[ARCHITECTURE.md](./ARCHITECTURE.md) for the big picture; this doc is the
"how do I actually get a change in" tactical playbook.

## Repo layout

Monorepo with **pnpm workspaces** + **turbo**. Five apps, eight shared
packages. The four runtimes use **Bun** (api/bot/worker) or **Vite** (web).

```
apps/
  api/      Hono + tRPC v11 + Drizzle (Bun runtime)
  web/      React 18 + Vite + Tailwind v3 + tRPC client + Tailwind v3
  bot/      grammY (Bun)
  worker/   BullMQ workers (Bun)

packages/
  domain/      Pure event-sourced aggregates (decide + apply); zero deps
  db/          Drizzle schema + migrations + RLS policies + seed
  contracts/   tRPC routes + Zod schemas (frontend + backend share)
  ui/          Concord design system (Sheet, Button, Input, Toast, …)
  i18n/        ICU runtime + 4 catalogs (en/zh/ru/uz)
  telemetry/   OpenTelemetry SDK + client log buffer
  cli/         `compass` command-line tool
```

## How to add a feature, end to end

The system is **event-sourced**: state lives in `domain.events` (append-only
log), gets projected into `read_model.*` views, and the FE reads those views.
Adding a feature means walking through 8–10 steps. None are optional.

### 1. Define the event

`packages/domain/src/<aggregate>/events.ts`. Add a TS type to the union and
the `OrderEventType` literal. Payload is part of the **public contract** —
once shipped, it's frozen. To change it, add a new TYPE (e.g.
`ItemAdjustedV2`) and update the projector to handle both.

### 2. Update the reducer (`apply`)

`packages/domain/src/<aggregate>/state.ts`. Add a case to the `apply()`
switch that mutates the in-memory aggregate state. `apply` is pure
(state, event) → state'. Replay determinism is gated by a unit test.

### 3. Define the command

`packages/domain/src/<aggregate>/commands.ts`. Add to the `OrderCommand`
union and the `decide()` switch. **decide is pure** — no DB, no clock leaks,
no random. The infra layer wraps it in a transaction with optimistic seq
enforcement. Throw `validation`, `forbidden`, `conflict`, or
`preconditionFailed` for invalid inputs (the i18n key in `message`
becomes the user-facing error).

### 4. Update the projector

`apps/api/src/services/<aggregate>Projection.ts`. Add a case for the new
event type that updates the read_model row(s). The projector runs in the
same transaction as the event append, so reads after the mutation see the
new state immediately.

### 5. Schema migration (if you need new columns)

```
packages/db/migrations/00xx_<descriptive>.sql
packages/db/migrations/meta/_journal.json   ← add the `idx` entry
```

Both are required. CI fails-closed on orphan SQL files (the bug that broke
0009 in prod for a week). Drizzle migrator skips the SQL file silently
if the journal entry is missing.

### 6. Wire the tRPC procedure

`apps/api/src/trpc/routers/<router>.ts`. Pattern:

```ts
mutation: authedProcedure.input(SomeInputSchema).mutation(async ({ ctx, input }) => {
  return ctx.withOrg(async (tx) => {
    const session = await loadSession(tx, ctx.session!.orgId, input.sessionId);
    const events = await readStream(tx, 'order', session.id);
    let state = emptyState(session.id);
    for (const e of events) state = apply(state, e);
    try {
      const out = decide(state, { type: 'YourCommand', /* ... */, actor: buildActor(ctx, state) });
      if (out.length === 0) return { lastSeq: state.seq };
      await appendEvents(tx, { streamType: 'order', streamId: session.id, orgId: ctx.session!.orgId, events: out });
      for (const e of out) state = apply(state, e);
      await projectOrder(tx, ctx.session!.orgId, out);
      return { lastSeq: state.seq };
    } catch (err) {
      rethrowDomainError(err);
    }
  });
}),
```

Define the input Zod schema in `packages/contracts/src/schemas/<aggregate>.ts`.
The wildcard re-export at `packages/contracts/src/index.ts` exposes it
automatically.

### 7. FE mutation hook

`apps/web/src/pages/<Page>.tsx`:

```ts
import { useErrToast } from '../lib/errToast';

const errToast = useErrToast();
const myMutation = trpc.order.someMutation.useMutation({
  onSuccess: () => {
    haptic('success');
    toast.success(i18n.t('some.toast.success'));
    void utils.order.todaySession.invalidate();
  },
  onError: errToast('some.toast.fallback'),
});
```

For frequently-tapped paths (e.g. OrderPage's qty +/-) use the **optimistic
cache + debounce + per-store serialize** pattern documented inline in
`OrderPage.tsx`. Don't invent your own retry logic — the offline outbox
(`useOfflineQueue`) handles network failures.

### 8. i18n — **always 4 catalogs**

Every user-visible string goes through `i18n.t(...)`. The 4 catalogs:

```
packages/i18n/src/catalogs/en.ts   (canonical — others fall back to this)
packages/i18n/src/catalogs/zh.ts
packages/i18n/src/catalogs/ru.ts
packages/i18n/src/catalogs/uz.ts
```

Add the key to `en.ts` first (the `CatalogKey` TS type infers from it), then
mirror to the other three. CI greps for the `^  '...':` count and fails the
build if they don't match. **Do not** ship a key in `en.ts` without a
translation in the others — the runtime falls back silently and ru/uz/zh
users see English.

### 9. Tests

| Layer | Tool | Where | Notes |
|---|---|---|---|
| Domain unit | `bun test` | `packages/domain/src/<a>/*.test.ts` | Pure decide/apply tests, no DB. Always cheap. |
| API integration | `bun test` (PG-gated) | `apps/api/src/__tests__/*.test.ts` | Spin up real Postgres + Drizzle migrate first. Skipped in CI via `SKIP_PG_TESTS=1`. |
| FE lib | `bun test` | `apps/web/src/lib/__tests__/`, `apps/web/src/hooks/__tests__/` | Pure utility tests. |
| Smoke | `bun run scripts/smoke.ts` | server-side tRPC against the live URL | 29 checks, ~5–10 s. |
| Browser smoke | `node scripts/browser-smoke*.ts` | Playwright against the live URL | Shallow render + deep walk. |

Aim for **at minimum** a domain unit test per command branch. PG-gated
integration is mandatory for any path that crosses a transaction boundary
(grant, transfer, cancel-cascade).

### 10. Smoke + deploy

```bash
bun run scripts/deploy.ts        # tar → scp → migrate → restart → vite → smoke
bun run scripts/deploy.ts --dry  # only run smoke against live, no deploy
```

The deploy script aborts before the API restart if migrations fail. Smokes
run after deploy and exit non-zero on regression — CI doesn't catch
runtime issues, smokes do.

## Conventions

- **TypeScript**: strict; `any` requires a comment. `unknown` over `any`
  for boundaries.
- **No `console.log` in src**: use `logger` from `@compass/telemetry`.
  Worker / bot CLIs are exempt (their stdout goes to journalctl).
- **Error keys** look like `<area>.errors.<camelCase>`. Server `TRPCError.message`
  IS the i18n key; FE auto-translates via `useErrToast()`.
- **Inline comments matter**. Tag with `M1.x (YYYY-MM-DD)` when the change
  is part of a numbered milestone. Audit reports live in `docs/M1.x-AUDIT.md`.
- **Event payloads are public contracts**. Adding a field to an existing
  type is breaking. Use a V2 type instead.
- **Multi-tenant safety**: every API path uses `ctx.withOrg(...)` (sets the
  `app.current_org_id` GUC for RLS). Or has explicit
  `eq(table.orgId, ctx.session.orgId)`. Both layers — RLS + app code —
  must hold.
- **Permissions**: declared in `packages/db/src/seed-data.ts`. Use granular
  keys (`users.invite`) over the legacy `users.manage` for new roles. Per-
  store scope flows through `getActorAdminStoreIds`.

## Local dev gotchas

- Postgres must be on **port 5433**, Redis on **6380** (the dev compose
  publishes those, not the defaults). `.env.example` matches.
- `pnpm install --frozen-lockfile` is what CI runs; mismatched lockfile
  fails the build.
- Telegram dev mode: `VITE_DEV_MOCK_INIT_DATA=1` in `.env` skips real HMAC.
  Never deploy with that set.
- Bun version pinned via `.bun-version`. CI uses `oven-sh/setup-bun` with
  `bun-version-file: .bun-version`.
- Migrations fail-fast on journal/SQL drift — see `packages/db/src/migrate.ts`
  `checkMigrationJournalConsistency`.

## What NOT to do

- **Never** mutate an existing event's payload schema — add a V2 type.
- **Never** call `tx.execute(sql.raw(\`'${id}'\`))` style. Use Drizzle's
  `inArray()`. Existing call-sites with raw IDs are db-loaded UUIDs, but
  the pattern is one PR away from an injection sink.
- **Never** skip the i18n catalog for ru/uz/zh. The English fallback is
  silent and embarrassing in front of real users.
- **Never** add a button without a permission check. Server gates first;
  FE conditional render second (defense in depth).
- **Never** commit `.env` files. `.gitignore` covers it; double-check before
  `git add -A`.

## Code review checklist

When reviewing a PR (yours or others):

- [ ] Domain layer is pure (no DB, no clock leak)
- [ ] Event payload schema is documented in `docs/EVENT_CATALOG.md`
- [ ] Migration has a journal entry
- [ ] All user-visible strings exist in all 4 catalogs
- [ ] Mutation has a test (unit or integration)
- [ ] Permissions checked on the SERVER
- [ ] FE handles loading + error + empty states (use `<DataState>`)
- [ ] No `console.log` in src
- [ ] No raw `err.message` in `toast.error` — use `errToast` helper
- [ ] Smoke tests pass on the deploy preview

## Where to look when…

- **Adding a permission**: `seed-data.ts` (PERMISSIONS array) + add to a
  built-in role + write a migration if existing orgs need backfill.
- **Adding a status to an aggregate**: events.ts (the `*EventType` union)
  → state.ts (the `*Status` type + apply cases) → commands.ts (decide
  branches that gate transitions) → projector → migration → API → FE.
- **Adding a page**: `apps/web/src/pages/`. Wire into `apps/web/src/Shell.tsx`
  bottom nav. Add an i18n key for the tab label in all 4 catalogs.
- **Adding a worker job**: `apps/worker/src/`. Drains from `sync.outbox`
  every 5 s with exponential backoff.

## When stuck

Read the audits in `docs/M1.x-AUDIT.md` — they're real reports from real
launch hardening passes and capture the patterns that have actually
broken. The `inline comments tagged with M1.x markers across the source
are a CHANGELOG you can grep.
