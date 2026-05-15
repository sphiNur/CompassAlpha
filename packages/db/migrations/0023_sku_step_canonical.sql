-- 0023_sku_step_canonical.sql
--
-- (M3.14, 2026-05-16) Coerce every `inventory.skus.step` value onto
-- the canonical {0.5, 1} grid.
--
-- BACKGROUND
--   The original schema accepted any positive decimal as the +/- step.
--   Field operators ended up with a mix of 0.25 / 0.1 / 5 / 50 / 100
--   depending on whoever filled the admin form. The QtyControl widget
--   then rendered increments the procurer had no way to relate to
--   real-world packaging ("0.25 kg of onions? what does that mean?").
--
--   M3.14 restricts the contract (`SkuStepSchema = enum(['0.5', '1'])`)
--   and the admin UI now ships a 2-option segmented control. This
--   migration backfills any pre-existing rows so the contract holds
--   over data we've already written.
--
-- MAPPING
--   step <= 0.5  → '0.5'  (weigh-and-pay band: 0.1, 0.25 collapse here)
--   step  > 0.5  → '1'    (countable / packaged: 5, 50, 100 collapse here)
--
--   This matches the JS coercion in AdminPage.snapStepToCanonical so
--   the UI and the DB stay consistent if the migration is re-run.
--
-- SAFETY
--   Idempotent. Wrapped in BEGIN/COMMIT. The UPDATE only touches rows
--   whose step is NOT already in {'0.5', '1'} (no churn on re-run).
--   A final assertion verifies post-state.

BEGIN;

-- ── coerce legacy values ─────────────────────────────────────────
-- inventory.skus.step is `numeric` on the server, so we compare and
-- assign with numeric literals, not text. The contract layer (TS)
-- shuttles the value as a string for JSON-safety, but in-DB it lives
-- as a decimal column.
UPDATE inventory.skus
   SET step = CASE
     WHEN step <= 0.5 THEN 0.5
     ELSE 1
   END,
       updated_at = now()
 WHERE step NOT IN (0.5, 1);

-- ── safety assertion ─────────────────────────────────────────────
DO $$
DECLARE
  bad_count int;
BEGIN
  SELECT count(*) INTO bad_count
    FROM inventory.skus
    WHERE step NOT IN (0.5, 1);
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'M3.14 backfill failed: % SKU row(s) still have non-canonical step', bad_count;
  END IF;
END $$;

COMMIT;
