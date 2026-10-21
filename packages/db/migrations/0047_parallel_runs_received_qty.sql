-- 0047_parallel_runs_received_qty.sql
--
-- (2026-10-21) Two audit fixes on the run read model.
--
-- CA-04 — one BUYING run per org, not one OPEN run.
--
-- 0035 allowed at most one run per org in ('planned', 'purchasing',
-- 'delivering'). A run sits in 'delivering' until EVERY store has signed
-- for its goods, so a single store that never confirmed blocked the whole
-- organisation from starting the next market trip. The race 0035 guards
-- against (two people opening a run mid-trip, one masking the other's
-- prices) only exists while a run is being planned or bought; once it is
-- out for delivery nobody records purchases into it any more. The index
-- is narrowed to ('planned', 'purchasing') so a new trip can start while
-- earlier ones are still being delivered / confirmed.
--
-- Narrowing a partial unique index can only admit more rows, so the
-- recreate cannot fail on existing data.
--
-- CA-06 — received quantity on problem lines.
--
-- run_item_stores_v.confirm_received_qty holds the qty a store reported
-- as actually received when it marked a line short / wrong / quality.
-- NULL for 'ok' lines and for every confirmation recorded before this
-- column existed; the StoreConfirmed projection books those at the full
-- split qty exactly as before, so a reproject of old streams produces the
-- same inventory movements.

DROP INDEX IF EXISTS "read_model"."mrv_one_active_per_org_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mrv_one_active_per_org_unique"
  ON "read_model"."market_runs_v" USING btree ("org_id")
  WHERE status IN ('planned', 'purchasing');
--> statement-breakpoint
ALTER TABLE "read_model"."run_item_stores_v"
  ADD COLUMN IF NOT EXISTS "confirm_received_qty" numeric(12, 3);
