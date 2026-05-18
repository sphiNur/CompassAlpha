-- 0027_run_claim.sql
--
-- (C.2, M3.38, 2026-05-19) Add run-level claim columns. Mirrors the
-- order-session claim columns from M3.19 + M3.22 — when two purchasers
-- open the same run they previously raced on every PurchaseItem with
-- only optimistic-concurrency to fall back on; the loser saw a
-- confusing "version conflict". A claim with the same shape (claimer
-- + ts + previous-claimer-on-override) gives a clean UX path: banner
-- + take-over button, worker auto-release on idle timeout.
--
-- SCHEMA
--   read_model.market_runs_v
--     + claimed_by_member_id      uuid, nullable
--     + claimed_at                timestamptz, nullable
--     + previous_claimer_member_id uuid, nullable  (force-release snapshot)
--
-- SAFETY
--   - IF NOT EXISTS for idempotency on re-run.
--   - All columns nullable, no default → no backfill scan.
--   - Index on (claimed_at) for the worker's stale-claim sweep.

BEGIN;

ALTER TABLE read_model.market_runs_v
  ADD COLUMN IF NOT EXISTS claimed_by_member_id uuid,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS previous_claimer_member_id uuid;

-- Worker sweep: WHERE claimed_by_member_id IS NOT NULL
--                 AND claimed_at < NOW() - interval '30m'
-- Partial index keeps it tiny — most rows are unclaimed.
CREATE INDEX IF NOT EXISTS mrv_claimed_idx
  ON read_model.market_runs_v (claimed_at)
  WHERE claimed_by_member_id IS NOT NULL;

COMMIT;
