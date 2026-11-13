# Tutorial screenshots

Walks every daily task as the person who does it, on a made-up demo
workspace, and saves one phone screenshot per step with the control to
tap ringed in red. It runs once per interface language and writes a
manifest the tutorial text is written from.

```bash
bun run tutorial:shots          # zh, ru, uz, en (about 2–3 minutes each)
bun run tutorial:shots ru en    # some of them
```

It needs what `pnpm test:e2e` needs (README one folder up): Postgres, and
a Chrome or Playwright's Chromium (`PLAYWRIGHT_CHANNEL=chrome` for the
installed Chrome). By default it uses the database
`postgres://compass:compass@localhost:5433/compass_e2e_tutorial` and
ports 3198 (api) and 5298 (web), so it does not meet an e2e run; set
`E2E_DATABASE_URL`, `E2E_API_PORT` and `E2E_WEB_PORT` to change them.
**Each language run erases that database** (the name must contain `e2e`
or `test`, as for e2e). Create it once:

```bash
psql -h localhost -p 5433 -U compass -d postgres -c 'create database compass_e2e_tutorial'
```

It is not part of `pnpm test:e2e` or CI: it has its own config
(`playwright.config.ts` here, which extends the e2e one) and its spec is
`*.tutorial.ts`, which the e2e config never looks for.

## Output

`tutorial-out/` at the repository root (git-ignored; `TUTORIAL_OUT`
moves it):

- `<lang>/<card-id>/<NN>-<step-id>.png`: 390×844 at 2× (780×1688 px).
- `manifest.json`: per card its id, role, English title, total taps and
  steps; per step its id, the screenshot and the ringed control's visible
  label in each language (read from the page), the number of taps, and
  notes for the writer. A step with no ring (`taps: 0`, `label: null`)
  shows the result. Card `notes` say what could not be shot.
- `.parts/<lang>.json`: what each language run recorded; `run.ts` merges
  them into the manifest, so running one language again updates only its
  part.

## The demo workspace

Seeded fresh for every language, with names in that language (`demo.ts`):
the organisation "Demo Kitchen", stores Central and Riverside, 12 products
in three categories (names in all four languages, from the dev seed), two
suppliers, two expense templates, and one person per role (owner, manager,
staff, purchaser, cashier, and a staff member who clocks in). Every name
is made up.

- `global-setup.ts` empties the database, migrates, and makes the
  organisation and its owner with the CLI (`compass org create`,
  `compass user grant`). It also draws the fake camera's picture
  (`camera.ts`).
- `seed.ts` (in the spec's `beforeAll`) adds the rest through the api as
  the owner, grants the other people their roles with `compass user
grant`, and signs each in once (signed Telegram initData, as
  `session.spec.ts` does) to confirm their name and language. Two things
  are written to the database directly because the app cannot make them
  without a real history or a real face: last week's prices (so the
  purchaser's one-tap ✓ works) and a face enrollment waiting for the
  manager (drawn placeholder photos).

## The walk

`cards.tutorial.ts` tells one story, card by card: the staff member
orders and withdraws, the manager rejects, the order is fixed and
approved, the purchaser buys, delivers, the store receives (one line
short), the run is finished, the cashier closes the day, the manager
counts stock, invites someone and approves a face, the clocker reaches the
camera, and the owner creates a store, adds a product, invites with a
role and switches clocking on. Controls are found by the app's own words
in the walk's language (`i18n.ts`), so a renamed label fails the walk.

`card.tap(step, control)` rings the control, saves the screen, then taps
it; `card.shot(step, control | null)` saves a screen without tapping
(typing into a field, or the result). While writing a step,
`TUTORIAL_DUMP_DIR=/tmp/x` makes `dump(page, name)` save the screen and
its accessibility tree.

Clock-in stops at the camera: Chrome's fake camera shows a drawn
silhouette, which the face tracker does not take for a face. A count's
"Save?" question is the browser's own dialog, so it is in the card's
notes, not in a screenshot.
