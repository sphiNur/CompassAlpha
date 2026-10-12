-- A corrected purchase left its first, wrong price in price_history for
-- good. Corrections append a row and nothing ever marked the old one, so
-- every average was computed over the mistakes as well: one lemon
-- purchase typed as 3,000,000, then 3,000, then 30, before it was fixed
-- to 30,000, put the product's 7-day average at 297,545.
--
-- superseded_at marks a row whose purchase was later corrected or taken
-- back. Rows are kept; readers skip the marked ones. price_history is a
-- read model (apps/api/scripts/reproject.ts rebuilds it from events),
-- so nothing here touches the event log.

ALTER TABLE inventory.price_history
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz;
--> statement-breakpoint

-- Backfill. One event writes all its rows with the same observed_at, so
-- for a given run and product only the latest observed_at is current;
-- everything before it was replaced by a correction (or by the old
-- habit of recording the same purchase twice). Grouped by run and
-- product, not by store: a correction rewrites every store's share, and
-- some first entries carry no store at all.
--
-- To undo: UPDATE inventory.price_history SET superseded_at = NULL
--          WHERE superseded_at IS NOT NULL;
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
