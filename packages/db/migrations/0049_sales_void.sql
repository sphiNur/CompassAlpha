-- 0049_sales_void.sql
--
-- (2026-10-21) Sales void — the follow-up 0017 promised.
--
-- Until now a mis-recorded sale could only be "fixed" by a stocktake,
-- which left the bogus sale in revenue and hid why the shelf count moved.
-- `sales.void` now marks the sale row voided (these three columns) and,
-- in the same transaction, appends reversing inventory.movements rows:
--
--   reason='consumption_reversed', source_type='sale_void',
--   source_id=<sales.id>, delta = -(original consumption delta)
--
-- A distinct source_type keeps the partial UNIQUE index
-- inv_mov_source_unique (source_type, source_id, store_id, sku_id) from
-- colliding with the original 'sale' rows while still allowing at most
-- one reversal per (sale, sku). `movements.reason` is a plain varchar
-- validated in app code (0015), so no constraint change is needed.
--
-- The sale row itself is never deleted: the ledger stays append-only and
-- revenue reports filter on voided_at IS NULL.
--
-- SAFETY: additive, nullable columns; existing rows read as "not voided".

ALTER TABLE "inventory"."sales"
  ADD COLUMN IF NOT EXISTS "voided_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "voided_by_member_id" uuid,
  ADD COLUMN IF NOT EXISTS "void_reason" text;
--> statement-breakpoint
ALTER TABLE "inventory"."sales"
  ADD CONSTRAINT "sales_void_consistency_check"
  CHECK (
    ("voided_at" IS NULL AND "void_reason" IS NULL)
    OR ("voided_at" IS NOT NULL AND char_length("void_reason") BETWEEN 1 AND 300)
  );
