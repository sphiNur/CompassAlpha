-- 0036_sku_unit_canonical.sql
--
-- (2026-07-30) Lock `inventory.skus.unit` to a fixed vocabulary and
-- widen `step` to the canonical {0.5, 1, 10, 50, 100} grid.
--
-- BACKGROUND
--   `unit` was free text. The prod catalog audit (2026-07-30) found
--   个 / ta / Pcs / karobka / boglima / "pcs（500g）" — six spellings
--   of "piece-ish" plus a grams unit whose history mixed gram- and
--   kg-semantics row by row. The contract now ships
--   SkuUnitSchema = enum(kg, L, pcs, pack, bunch, box, roll, pair)
--   and the admin sheet renders a Select, so new writes are clean.
--   This migration backfills old rows and adds CHECK constraints so
--   the DB enforces the vocabulary even for out-of-band writes.
--
--   `g` is retired: weigh-and-pay goods are always kg (liquids L).
--   The one-off prod surgery that rescaled gram-semantics history
--   (qty /1000, per-gram price *1000) is NOT repeated here — this
--   migration only normalizes the label; dev/seed databases carry no
--   history worth rescaling.
--
-- SAFETY
--   Idempotent. The UPDATEs only touch non-conforming rows; the
--   constraints are dropped and re-added.

BEGIN;

UPDATE inventory.skus
   SET unit = CASE
     WHEN unit = 'g'        THEN 'kg'
     WHEN unit = 'karobka'  THEN 'box'
     WHEN unit = 'boglima'  THEN 'bunch'
     WHEN unit IN ('kg','L','pcs','pack','bunch','box','roll','pair') THEN unit
     ELSE 'pcs' -- 个 / ta / Pcs / "pcs（500g）" and any other stray spelling
   END,
       updated_at = now()
 WHERE unit NOT IN ('kg','L','pcs','pack','bunch','box','roll','pair');

UPDATE inventory.skus
   SET step = CASE WHEN step <= 0.5 THEN 0.5 ELSE 1 END,
       updated_at = now()
 WHERE step NOT IN (0.5, 1, 10, 50, 100);

ALTER TABLE inventory.skus DROP CONSTRAINT IF EXISTS skus_unit_canonical;
ALTER TABLE inventory.skus ADD CONSTRAINT skus_unit_canonical
  CHECK (unit IN ('kg','L','pcs','pack','bunch','box','roll','pair'));

ALTER TABLE inventory.skus DROP CONSTRAINT IF EXISTS skus_step_canonical;
ALTER TABLE inventory.skus ADD CONSTRAINT skus_step_canonical
  CHECK (step IN (0.5, 1, 10, 50, 100));

COMMIT;
