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
the `OrderEventType` literal, a row to `docs/EVENT_CATALOG.md`, and the type
to `packages/domain/src/eventCatalog.test.ts`. Payload is part of the
**public contract**: written events are never rewritten. A payload may gain
an optional field, or an enum a new value, when every reader handles its
absence; the catalog records what absence means. Anything else (changing a
field's meaning, making one required) needs a new TYPE (e.g.
`ItemAdjustedV2`) and a projector that handles both.

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

The new entry goes last: `idx` one more than the entry before, and `when`
later than its `when`. Drizzle applies an entry only when its `when` is
later than the newest migration the database recorded, and passes over an
earlier one without a word. Two branches can both take "the last `when` +
1"; the one that merges second moves its entry to the end. `migrate`
refuses a journal out of order, and a database that recorded a migration
dated after an entry it never applied (DB-07).

No `BEGIN`, `COMMIT` or `ROLLBACK` in a migration: the runner applies each
batch in one transaction, and a file's own `COMMIT` ends it early for every
file after it (`migrate` refuses such a file; 23 early ones are
grandfathered in `packages/db/src/migrationLint.ts`). The runner also sets
the `maintenance` system context for its whole session, so a backfill
under FORCE RLS sees every tenant without a `set_config` of its own. Do not
set or clear `app.system_context` in a migration.

Write the SQL by hand. Do not run `drizzle-kit generate` (`pnpm
db:generate` now refuses): `meta/` only has the snapshot of 0000, and
about two dozen CHECK constraints exist only in the SQL, so the
generated diff would be against the first schema and could drop or
rename columns (D8). Keep the Drizzle schema in `src/schema/` in step
with what the SQL creates.

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
| API integration | `bun test` (PG-gated) | `apps/api/src/__tests__/*.test.ts` | Migrate a throwaway Postgres first, named like `compass_test`: a test run refuses a database without `test` or `e2e` as a word of its name (`latest` is not one). CI's unit job skips them with `SKIP_PG_TESTS=1`; its integration job runs them. |
| FE lib | `bun test` | `apps/web/src/lib/__tests__/`, `apps/web/src/hooks/__tests__/` | Pure utility tests. |
| Smoke | `bun run scripts/smoke.ts` | server-side tRPC against the live URL | 29 checks, ~5–10 s. |
| Browser smoke | `node scripts/browser-smoke*.ts` | Playwright against the live URL | Shallow render + deep walk. |

Aim for **at minimum** a domain unit test per command branch. PG-gated
integration is mandatory for any path that crosses a transaction boundary
(grant, transfer, cancel-cascade).

The directories CI and the deploy test are listed once, in
`scripts/lib/testTargets.ts`. A test file outside them, or a PG-gated one
outside the integration directories, fails
`scripts/__tests__/testTargets.test.ts`: add the directory there and to
the matching step in `.github/workflows/ci.yml`.

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
  is part of a numbered milestone, or with the review finding it fixes
  (`review OPS-07 (2026-11)`). Audit reports are not kept in the repo:
  what they found is fixed in the code, with a comment where it matters.
- **Event payloads are public contracts**. An existing type only gains
  optional fields that every reader handles when absent, each recorded in
  `docs/EVENT_CATALOG.md` with its meaning on older events. Anything else
  is a V2 type.
- **Multi-tenant safety**: every API path uses `ctx.withOrg(...)` (sets the
  `app.current_org_id` GUC for RLS). Or has explicit
  `eq(table.orgId, ctx.session.orgId)`. Both layers — RLS + app code —
  must hold.
- **Permissions**: declared in `packages/db/src/seed-data.ts`. Use granular
  keys (`users.grant_role`) over the legacy `users.manage` for new roles.
  Per-store scope flows through `getActorAdminStoreIds`.

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

- **Never** rewrite a stored event, or change what an existing payload
  field means — add a V2 type.
- **Never** splice ids into SQL (`sql.raw(\`'${id}'\`)`): the pattern is one
  PR away from an injection sink. Use Drizzle's `inArray()`, or `inUuids()` /
  `inTexts()` from `apps/api/src/services/sqlIn.ts` inside a `sql` template.
  `no-raw-sql.test.ts` fails on any `sql.raw` in the API's source.
- **Never** skip the i18n catalog for ru/uz/zh. The English fallback is
  silent and embarrassing in front of real users.
- **Never** add a button without a permission check. Server gates first;
  FE conditional render second (defense in depth).
- **Never** commit `.env` files. `.gitignore` covers it; double-check before
  `git add -A`.

## Code review checklist

When reviewing a PR (yours or others):

- [ ] Domain layer is pure (no DB, no clock leak)
- [ ] New event types and payload fields are in `docs/EVENT_CATALOG.md`
      (a new field is optional, with its meaning when absent)
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

The inline comments tagged with M1.x markers or review finding ids
(`review COREWEB2-01`) across the source are a CHANGELOG you can grep:
they say what actually broke and why the code is the way it is.
