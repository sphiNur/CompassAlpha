-- 0016_dishes_and_recipes.sql
--
-- (M2.0b, 2026-05-08) Dishes (menu items) + recipe / BOM.
--
-- Second step of the ERP shift. M2.0a (`inventory.movements`) gave us
-- "what's on the shelf". M2.0b gives us "what we sell, and what each
-- sale consumes". The two tables here join the dots so M2.0c can wire
-- sales-recording → inventory-deduction via the recipe BOM.
--
-- Two tables, no events:
--
--   inventory.dishes
--     Menu items. Parallel structure to inventory.skus — per-org,
--     i18n names, optional code, sort_index, is_archived. Adds
--     `unit_price` (selling price per serving, optional) so future
--     revenue reports have something to multiply by. NOT event-
--     sourced; menu edits are CRUD just like SKU edits.
--
--   inventory.dish_ingredients
--     Recipe rows. One per (dish, SKU) pair with qty_per_serving in
--     the SKU's native unit. Decimal(12,4) gives 4-decimal precision
--     (enough for "5 g of salt = 0.005 kg"). Optional note for
--     kitchen-side context.
--
-- Primary key (dish_id, sku_id) means a dish can have at most one
-- row per ingredient. The application (M2.0c) sums consumption as
-- SUM(qty_per_serving * sale_qty) per SKU at the destination store.
--
-- No selling currency on dishes — auth.organizations.currency (M1.17)
-- is the org-wide currency for both selling and buying. Multi-
-- currency dishes (e.g. tourist-area menu pricing in USD alongside
-- UZS) would need a per-dish currency column; deferred until the
-- second tenant actually needs it.
--
-- RLS: same pattern as inventory.movements — policy gates rows by
-- current_setting('app.current_org_id'). Recipe rows have no org_id
-- of their own; they piggyback the parent dish's org via FK and the
-- app-level `withOrg(tx)` scope.

CREATE TABLE inventory.dishes (
  id            UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID            NOT NULL REFERENCES auth.organizations(id) ON DELETE CASCADE,
  code          VARCHAR(32),
  names         JSONB           NOT NULL DEFAULT '{}'::jsonb,
  description   JSONB           NOT NULL DEFAULT '{}'::jsonb,
  unit_price    NUMERIC(14, 2),
  sort_index    INTEGER         NOT NULL DEFAULT 0,
  is_archived   BOOLEAN         NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX dishes_org_idx
  ON inventory.dishes (org_id, is_archived);

CREATE UNIQUE INDEX dishes_org_code_unique
  ON inventory.dishes (org_id, code)
  WHERE code IS NOT NULL;

ALTER TABLE inventory.dishes ENABLE ROW LEVEL SECURITY;

CREATE POLICY dishes_org_isolation
  ON inventory.dishes
  USING (org_id::text = current_setting('app.current_org_id', true));

CREATE TABLE inventory.dish_ingredients (
  dish_id           UUID           NOT NULL REFERENCES inventory.dishes(id) ON DELETE CASCADE,
  sku_id            UUID           NOT NULL REFERENCES inventory.skus(id)   ON DELETE CASCADE,
  qty_per_serving   NUMERIC(12, 4) NOT NULL,
  note              TEXT,
  created_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  PRIMARY KEY (dish_id, sku_id)
);

CREATE INDEX dish_ing_sku_idx
  ON inventory.dish_ingredients (sku_id);

ALTER TABLE inventory.dish_ingredients ENABLE ROW LEVEL SECURITY;

-- Recipe rows piggyback org_id via the parent dish. Policy joins to
-- the dish table to authorize. Slightly more expensive than the
-- direct-column check but keeps the schema normalized.
CREATE POLICY dish_ingredients_org_isolation
  ON inventory.dish_ingredients
  USING (
    EXISTS (
      SELECT 1
      FROM inventory.dishes d
      WHERE d.id = dish_ingredients.dish_id
        AND d.org_id::text = current_setting('app.current_org_id', true)
    )
  );
