-- 0017_sales.sql
--
-- (M2.0c, 2026-05-08) Sales recording — closes the ERP loop.
--
-- M2.0a gave us inventory ledger. M2.0b gave us menu + recipes.
-- M2.0c records sales and auto-deducts ingredient inventory in the
-- same DB transaction, so the on-hand view in Admin → Stores →
-- Inventory stays accurate without manual stocktakes after every
-- shift.
--
-- One row per "we sold N portions of dish X at store Y" event. The
-- application-level `sales.record` mutation writes:
--
--   1) one row into inventory.sales (this table)
--   2) N rows into inventory.movements with
--        sourceType='sale', sourceId=<this row's id>,
--        delta = -(sale.qty × qty_per_serving),
--        reason='consumption'
--
-- ...all inside one DB transaction. If the auto-deduct fails (e.g.
-- the dish has no recipe), the whole sale rolls back rather than
-- creating a sale-without-deduction inconsistency.
--
-- Idempotency via the existing partial UNIQUE index on
-- inventory.movements (source_type, source_id, store_id, sku_id):
-- a replay or double-fire of `sales.record` produces at most one
-- deduction per (sale, sku) pair.
--
-- NOT in this migration:
--   * sales.delete / sales.edit — first cut is record-only.
--     Mistakes are corrected via stocktake (M2.0a).
--   * No `cancelled_at` or soft-delete column — when M2.x adds
--     edit/delete, we'll add a `voided_at` column and an
--     `ItemConsumptionReversed`-style row in movements.
--
-- RLS: same `current_setting('app.current_org_id')` pattern.

CREATE TABLE inventory.sales (
  id                       UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   UUID            NOT NULL REFERENCES auth.organizations(id) ON DELETE CASCADE,
  store_id                 UUID            NOT NULL REFERENCES inventory.stores(id)   ON DELETE CASCADE,
  -- ON DELETE RESTRICT on dish_id — historical sales must always be
  -- resolvable to a dish name. Archive the dish, don't delete.
  dish_id                  UUID            NOT NULL REFERENCES inventory.dishes(id)   ON DELETE RESTRICT,
  qty                      NUMERIC(10, 2)  NOT NULL,
  unit_price               NUMERIC(14, 2),
  recorded_by_member_id    UUID,
  occurred_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  created_at               TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX sales_store_time_idx ON inventory.sales (store_id, occurred_at);
CREATE INDEX sales_org_time_idx   ON inventory.sales (org_id,   occurred_at);
CREATE INDEX sales_dish_idx       ON inventory.sales (dish_id,  occurred_at);

ALTER TABLE inventory.sales ENABLE ROW LEVEL SECURITY;

CREATE POLICY sales_org_isolation
  ON inventory.sales
  USING (org_id::text = current_setting('app.current_org_id', true));
