ALTER TABLE read_model.run_item_stores_v
  ADD COLUMN IF NOT EXISTS unit_price numeric(14, 2),
  ADD COLUMN IF NOT EXISTS payment_method varchar(16);

ALTER TABLE read_model.run_item_stores_v
  DROP CONSTRAINT IF EXISTS risv_payment_method_check;

ALTER TABLE read_model.run_item_stores_v
  ADD CONSTRAINT risv_payment_method_check
  CHECK (payment_method IS NULL OR payment_method IN ('cash', 'transfer'));
