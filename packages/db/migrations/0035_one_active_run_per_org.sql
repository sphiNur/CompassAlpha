-- 0035_one_active_run_per_org.sql
--
-- (2026-07-26) At most ONE non-terminal market run per organization.
--
-- WHY
--
-- Nothing enforced this. The existing unique key is
-- (org_id, run_date, run_index), which happily allows a second run
-- beside a live one. The domain's guard in PlanRun is
-- `state.status !== 'absent'`, and a brand-new stream id is always
-- absent, so it never fires. Meanwhile the client's `activeRun` takes
-- the FIRST row of a list ordered by (run_date DESC, run_index DESC) —
-- so a second run does not merely coexist, it MASKS the first, along
-- with every price already recorded into it. The purchaser's screen
-- silently switches trips.
--
-- Today that needs two people to tap "new run" within the same moment.
-- Q7(a) makes run creation implicit — the first recorded purchase
-- creates the run — which moves that race off a deliberate button press
-- and into the middle of a market trip. The constraint has to land
-- first.
--
-- WHAT IT DOES NOT DO
--
-- Multiple runs PER DAY stay legal, and that matters: production shows
-- 2-3 runs on several days (a morning trip and an evening one). The
-- constraint is only on runs that are still OPEN.
--
-- SAFETY
--
-- Verified against production before writing: 71 runs across the full
-- history, and zero pairs were ever simultaneously non-terminal (checked
-- by comparing each run's first-event → terminal-event interval). This
-- encodes the way the system is already used rather than changing it.
--
-- If a violation somehow exists at deploy time this index creation
-- fails, `pnpm --filter @compass/db migrate` exits non-zero, and
-- deploy.ts aborts BEFORE restarting the api — production keeps running
-- the previous build. That is the correct failure mode: refuse to ship
-- rather than ship a half-applied constraint.
--
-- Idempotent via IF NOT EXISTS, so re-runs are no-ops.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS mrv_one_active_per_org_unique
  ON read_model.market_runs_v (org_id)
  WHERE status IN ('planned', 'purchasing', 'delivering');

COMMIT;
