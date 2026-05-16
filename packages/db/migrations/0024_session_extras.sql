-- 0024_session_extras.sql
--
-- (M3.16-C, 2026-05-16) Replace the free-text `notes` "其他物品" field
-- on order sessions with a structured `extras_json` array.
--
-- BACKGROUND
--   The original implementation (M1.8) shipped session-level notes as
--   a single text blob. Staff typed lines like "辣椒粉 200g, 酵母 1包"
--   into a textarea. The approver / runner got the same blob back —
--   no per-line qty, no unit, no way to copy-paste into the supplier
--   handoff cleanly.
--
--   M3.16-C reshapes this as an array of { name, qty, unit, note? }
--   objects. UI ships a structured row editor; downstream pages render
--   a clean list; future work can promote frequent extras to real SKUs.
--
-- SCHEMA CHANGE
--   Add a `read_model.order_sessions_v.extras_json` jsonb column,
--   default '[]'::jsonb, NOT NULL. The existing `notes` column STAYS
--   for backwards-compat reads of pre-M3.16 sessions; new writes go
--   through `extras_json`.
--
-- SAFETY
--   Idempotent. ADD COLUMN IF NOT EXISTS so re-runs are safe. No data
--   migration needed — the column defaults to an empty array, which
--   means "no extras". Old `notes` content remains readable on a per-
--   session basis until the relevant sessions archive.

BEGIN;

ALTER TABLE read_model.order_sessions_v
  ADD COLUMN IF NOT EXISTS extras_json jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Sanity: every row should have the default '[]' shape now.
DO $$
DECLARE
  bad_count int;
BEGIN
  SELECT count(*) INTO bad_count
    FROM read_model.order_sessions_v
    WHERE extras_json IS NULL;
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'M3.16-C: % session(s) have NULL extras_json after default backfill', bad_count;
  END IF;
END $$;

COMMIT;
