# End-to-end tests

Drives the real app in Chromium: the real api on a real database, the web
dev server, and the development login. Nothing is stubbed.

```bash
# Any Postgres 16 you can afford to lose. The database name must contain
# "e2e" or "test": every run drops the application schemas and rebuilds
# them from migrations + seed.
export E2E_DATABASE_URL=postgres://compass:compass@localhost:5433/compass_e2e

pnpm --filter @compass/e2e exec playwright install chromium   # once
pnpm test:e2e
```

The api and web servers are started for you (ports 3100 and 5273;
override with `E2E_API_PORT` / `E2E_WEB_PORT`). Locally, servers already
listening on those ports are reused.

`pnpm --filter @compass/e2e exec playwright test --ui` opens the runner
with a live browser. Each step attaches a full-page screenshot to the
report; a failing run also keeps a trace under `test-results/`.

## Writing a step

Find things the way a person does — by role and visible name — and reach
for a `data-testid` only where there is no name to go by (`nav-<tab>`,
`page-main-button`, `open-settings`). Sheets are `role=dialog`.

Text inside a region often has no whitespace between elements
(`Stores0/1 confirmed`), so match with `\s*` rather than a literal space.
