-- 0073_run_item_top_up.sql
--
-- (2026-11-13, review RUNAPI-12) Each run item's "still need X" (BUY-5:
-- demand that joined after the item was bought or marked unavailable)
-- lived in the domain state only, so every run.get read and replayed the
-- run's whole event stream to show it. The run projection now keeps it in
-- read_model.run_items_v.top_up_qty, with the reducer's arithmetic
-- (apps/api/src/services/runProjection.ts).
--
--   run_items_v.top_up_qty    NULL = nothing outstanding, as in the state.
--   market_runs_v.top_up_seq  the stream seq up to which the run's
--                             top_up_qty values are exact. run.get trusts
--                             them only when top_up_seq = last_seq, and
--                             otherwise replays the stream as before.
--
-- The seq, not a flag: anything that appends to a run without the new
-- projection (the release still running between this migration and the
-- restart, the worker's claim timeout before it learns the column) moves
-- last_seq and leaves top_up_seq behind, so the reader falls back instead
-- of showing a stale figure. The projection catches a run that fell behind
-- up again from its stream at the run's next event.
--
-- BACKFILL. A top-up only ever grows through SessionsAttachedToRun; every
-- other event keeps, lowers or clears it. A run whose stream has no such
-- event therefore has no top-up on any item, so its NULLs are already
-- exact and it is marked current here, from domain.events alone. A run
-- with attached sessions keeps top_up_seq NULL: run.get replays its
-- stream (as before this migration) until its next event brings it up to
-- date, or `reproject.ts --top-ups` fills it. Nothing has to be run by
-- hand.
--
-- SAFETY: both columns are nullable without a default, so neither ADD
-- COLUMN rewrites its table. The UPDATE touches only market_runs_v (one
-- row per run) and reads domain.events by its (stream_id, seq) index.
-- Running the file again changes nothing: the columns exist, and the
-- UPDATE skips runs whose top_up_seq is set.

ALTER TABLE "read_model"."run_items_v"
  ADD COLUMN IF NOT EXISTS "top_up_qty" numeric(12, 3);
--> statement-breakpoint
ALTER TABLE "read_model"."market_runs_v"
  ADD COLUMN IF NOT EXISTS "top_up_seq" bigint;
--> statement-breakpoint
UPDATE "read_model"."market_runs_v" m
SET "top_up_seq" = m."last_seq"
WHERE m."top_up_seq" IS NULL
  AND m."last_seq" = (
    SELECT max(e."seq") FROM "domain"."events" e
    WHERE e."stream_type" = 'run' AND e."stream_id" = m."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "domain"."events" e
    WHERE e."stream_type" = 'run'
      AND e."stream_id" = m."id"
      AND e."type" = 'SessionsAttachedToRun'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "read_model"."run_items_v" ri
    WHERE ri."run_id" = m."id" AND ri."top_up_qty" IS NOT NULL
  );
