-- 0018_sales_qty_precision.sql
--
-- (M1.20, 2026-05-08, launch hardening) Bring inventory.sales.qty in
-- line with the rest of the qty columns.
--
-- The 0017 migration created `sales.qty` as NUMERIC(10, 2). Every
-- other quantity column in the schema is NUMERIC(12, 3) — including
-- the inventory.movements rows that sales.record AUTO-EMITS at the
-- same instant. Mixing precisions produces silent rounding in the
-- BOM-multiplication step (qty_per_serving × sale_qty), so a sale of
-- 0.001 of anything truncates to 0.00 on the sale row but 0.001 on
-- the movement row.
--
-- Fix: ALTER COLUMN ... TYPE ... USING the current value cast through.
-- Postgres will rewrite the column in place. Existing data (if any)
-- gets re-coerced; values that fit the OLD type also fit the new one
-- losslessly.
--
-- Reversible: dropping back to NUMERIC(10, 2) would truncate any rows
-- with 3rd-decimal precision. Don't roll back through this migration
-- unless the operator has confirmed no such rows exist.

ALTER TABLE inventory.sales
  ALTER COLUMN qty TYPE NUMERIC(12, 3) USING qty::NUMERIC(12, 3);
