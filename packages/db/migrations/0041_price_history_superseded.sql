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

-- The rows that were already wrong when this column arrived are marked
-- by 0042. The backfill first sat here and marked nothing: migrations
-- connect as the application role, price_history is under FORCE ROW
-- LEVEL SECURITY, and without an org or system context an UPDATE sees
-- no rows at all — while the migration is still recorded as applied.
