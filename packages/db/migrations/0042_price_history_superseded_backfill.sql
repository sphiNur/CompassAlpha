-- Marks the price observations that were already superseded when 0041
-- added the column: a purchase that was later corrected, recorded
-- twice, or taken back.
--
-- price_history is under FORCE ROW LEVEL SECURITY and migrations run as
-- the application role. Without a context the UPDATE below matches no
-- rows and still succeeds, which is how the first version of this
-- backfill (inside 0041) did nothing. The context is transaction-local
-- and cleared again at the end, so no later migration inherits it.
SELECT set_config('app.system_context', 'maintenance', true);
--> statement-breakpoint

-- One event writes all its rows with the same observed_at, so for a
-- given run and product only the latest observed_at is current. Grouped
-- by run and product, not by store: a correction rewrites every store's
-- share, and some first entries carry no store at all.
--
-- To undo: UPDATE inventory.price_history SET superseded_at = NULL
--          WHERE superseded_at IS NOT NULL;
-- (with the same context set, or as a role that bypasses RLS).
UPDATE inventory.price_history ph
SET superseded_at = now()
WHERE ph.run_id IS NOT NULL
  AND ph.superseded_at IS NULL
  AND (
    ph.observed_at < (
      SELECT max(later.observed_at)
      FROM inventory.price_history later
      WHERE later.run_id = ph.run_id
        AND later.sku_id = ph.sku_id
    )
    -- The purchase was taken back and the line is not bought any more.
    OR NOT EXISTS (
      SELECT 1
      FROM read_model.run_items_v ri
      WHERE ri.run_id = ph.run_id
        AND ri.sku_id = ph.sku_id
        AND ri.status = 'purchased'
    )
  );
--> statement-breakpoint

SELECT set_config('app.system_context', '', true);
