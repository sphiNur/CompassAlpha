-- 0039_settlement_itemized_expenses.sql
--
-- Daily-close outflows must be explainable line by line. These JSONB arrays
-- stay on the one-store/one-date close so the existing immutable revision
-- snapshot can capture the complete version atomically.

ALTER TABLE inventory.store_daily_settlements
  ADD COLUMN IF NOT EXISTS operating_expense_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS wage_items jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Do not rewrite a historical close: every earlier revision snapshot must
-- remain byte-for-byte truthful. The API exposes a clearly marked virtual
-- historical row when it encounters a non-zero legacy total with an empty
-- array, so old amounts remain visible without inventing a person or receipt.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sds_operating_expense_items_array'
  ) THEN
    ALTER TABLE inventory.store_daily_settlements
      ADD CONSTRAINT sds_operating_expense_items_array
      CHECK (jsonb_typeof(operating_expense_items) = 'array');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sds_wage_items_array'
  ) THEN
    ALTER TABLE inventory.store_daily_settlements
      ADD CONSTRAINT sds_wage_items_array
      CHECK (jsonb_typeof(wage_items) = 'array');
  END IF;
END $$;
