-- 0072_sales_void_reason_not_null.sql
--
-- (2026-11-13) 0049's sales_void_consistency_check let a voided sale
-- through with no reason. Its voided branch read
--
--   "voided_at" IS NOT NULL AND char_length("void_reason") BETWEEN 1 AND 300
--
-- and char_length(NULL) is NULL, so for voided_at set and void_reason NULL
-- the whole CHECK came out NULL, which a CHECK accepts. The voided branch
-- now says "void_reason" IS NOT NULL first; every other case is unchanged.
--
-- sales.void always writes a reason, so existing rows should pass. The
-- constraint is added NOT VALID and then validated in this same migration:
-- should a voided row without a reason exist, VALIDATE fails and the whole
-- migration rolls back, with the old constraint still in place. Find such
-- rows with
--   SELECT id FROM inventory.sales
--   WHERE voided_at IS NOT NULL AND void_reason IS NULL;
--
-- SAFETY: VALIDATE reads the table once under SHARE UPDATE EXCLUSIVE; the
-- table is small.

ALTER TABLE "inventory"."sales"
  DROP CONSTRAINT IF EXISTS "sales_void_consistency_check";
--> statement-breakpoint
ALTER TABLE "inventory"."sales"
  ADD CONSTRAINT "sales_void_consistency_check"
  CHECK (
    ("voided_at" IS NULL AND "void_reason" IS NULL)
    OR (
      "voided_at" IS NOT NULL
      AND "void_reason" IS NOT NULL
      AND char_length("void_reason") BETWEEN 1 AND 300
    )
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE "inventory"."sales"
  VALIDATE CONSTRAINT "sales_void_consistency_check";
