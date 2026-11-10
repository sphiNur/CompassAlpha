# End-to-end tests

Drives the real app in Chromium: the real api on a real database, the web
dev server, and the development login. Nothing is stubbed.

```bash
# Any Postgres 18 you can afford to lose. The database name must contain
# "e2e" or "test": every run drops the application schemas and rebuilds
# them from migrations + seed.
export E2E_DATABASE_URL=postgres://compass:compass@localhost:5433/compass_e2e

pnpm --filter @compass/e2e exec playwright install chromium   # once
pnpm test:e2e
```

The api and web servers are started for you (ports 3100 and 5273;
override with `E2E_API_PORT` / `E2E_WEB_PORT`). A server already
listening on either port stops the run instead of being reused: it may be
connected to another database, and only `E2E_DATABASE_URL` is reset.

The files tell one story on one database. `main-flow.spec.ts` walks the
app from a fresh database, and `render-count.spec.ts` measures the
screens it leaves behind; its project depends on main-flow's
(`playwright.config.ts`), so running it alone runs main-flow first. There
are no retries: a retry would replay the story on the database the first
attempt changed.

`pnpm --filter @compass/e2e exec playwright test --ui` opens the runner
with a live browser. Each step attaches a full-page screenshot to the
report; a failing run also keeps a trace under `test-results/`.

`@playwright/test` here and `playwright` in the root package.json (the
deploy's browser smokes) are pinned to the same exact version, so one
browser build serves both. Bump them together;
`scripts/__tests__/playwrightVersion.test.ts` fails otherwise (OPS-20).

## Writing a step

Find things the way a person does — by role and visible name — and reach
for a `data-testid` only where there is no name to go by (`nav-<tab>`,
`page-main-button`, `open-settings`). Sheets are `role=dialog`.

Text inside a region often has no whitespace between elements
(`Stores0/1 confirmed`), so match with `\s*` rather than a literal space.
