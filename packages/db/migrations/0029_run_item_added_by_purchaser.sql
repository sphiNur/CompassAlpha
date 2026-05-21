-- 0029_run_item_added_by_purchaser.sql
--
-- (M3.41, 2026-05-21) Add `added_by_purchaser` to run_items_v so the
-- read model can distinguish rows the original order asked for from
-- rows the purchaser added mid-run via `AddPurchaserItem`.
--
-- BACKGROUND
--   M3.41 lets the purchaser record a buy for a SKU that was NOT in
--   the original aggregated demand (e.g. impromptu buy at the bazaar,
--   chef phoned in a top-up, supplier threw in a freebie). The domain
--   layer emits a new `PurchaserItemAdded` event instead of
--   `ItemPurchased` so the audit log can answer "ordered vs. added
--   beyond the ask" without walking the original session demand.
--
--   The projection writes the new column. Reports + finish summary
--   read it to render a "added X / Y UZS" breakdown next to the
--   ordered total.
--
-- SAFETY
--   IF NOT EXISTS for re-run idempotency.
--   NOT NULL DEFAULT false → no backfill scan; every existing row
--   stays at false (which is correct: pre-M3.41, no row ever came
--   from a purchaser-initiated event).

BEGIN;

ALTER TABLE read_model.run_items_v
  ADD COLUMN IF NOT EXISTS added_by_purchaser boolean NOT NULL DEFAULT false;

COMMIT;
