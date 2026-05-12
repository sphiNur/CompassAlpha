-- 0015_inventory_movements.sql
--
-- (M2.0a, 2026-05-08) Inventory ledger — append-only book of deltas.
--
-- First step of the ERP direction. Until M2.0a the system tracked
-- purchases but had no concept of "what's currently on the shelf".
-- That left users unable to:
--   * Plan an order based on actual depletion (vs. guessing)
--   * Spot stock-outs before they bite (M2.0d alert step)
--   * Calculate wastage / breakage / spoilage (M2.0a manual entry)
--   * Auto-deduct on sales via recipe BOM (M2.0c follow-up)
--
-- Design decision: NOT event-sourced. Inventory is a ledger, not a
-- state machine — there are no guarded transitions, only signed
-- deltas. Append-only `inventory.movements` rows + SUM-GROUP-BY for
-- current on-hand is the simplest correct model. Event sourcing
-- (with Map<skuId, qty> in aggregate state) would compound the
-- snapshot pain we already have on long Run streams without buying
-- any business-logic safety.
--
-- Idempotency: the partial unique index on (source_type, source_id,
-- store_id, sku_id) — where both source fields are non-null — means
-- the auto-receive hook on StoreConfirmed can fire twice without
-- double-counting. A reproject (M1.16) replay path will insert via
-- ON CONFLICT DO NOTHING.
--
-- RLS: defer-to-app pattern, same as run / order tables. Every read
-- goes through `withOrg(tx)` which sets the local org_id session var;
-- the policy on `inventory.movements` checks `org_id = current_org()`.

CREATE TABLE inventory.movements (
  id                UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID            NOT NULL REFERENCES auth.organizations(id) ON DELETE CASCADE,
  store_id          UUID            NOT NULL REFERENCES inventory.stores(id)   ON DELETE CASCADE,
  sku_id            UUID            NOT NULL REFERENCES inventory.skus(id)     ON DELETE CASCADE,
  delta             NUMERIC(12, 3)  NOT NULL,
  -- delivery_received | stocktake | wastage | consumption | transfer_in
  -- | transfer_out | adjustment. Validated in app code; kept as
  -- varchar so adding a new reason doesn't require a migration.
  reason            VARCHAR(32)     NOT NULL,
  note              TEXT,
  source_type       VARCHAR(32),
  source_id         UUID,
  actor_member_id   UUID,
  occurred_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX inv_mov_store_sku_idx
  ON inventory.movements (store_id, sku_id, occurred_at);

CREATE INDEX inv_mov_org_time_idx
  ON inventory.movements (org_id, occurred_at);

CREATE INDEX inv_mov_source_idx
  ON inventory.movements (source_type, source_id);

-- Idempotency guard. Partial: only rows that link back to a domain
-- source get the unique constraint. Pure manual movements (stocktake,
-- wastage) can have multiple entries at the same instant — operator
-- might log two breakages in the same minute.
CREATE UNIQUE INDEX inv_mov_source_unique
  ON inventory.movements (source_type, source_id, store_id, sku_id)
  WHERE source_type IS NOT NULL AND source_id IS NOT NULL;

-- ── RLS ──────────────────────────────────────────────────────────
-- Same pattern as run / order tables: deny all by default, allow only
-- rows whose org_id matches the session-local var set by withOrg().
ALTER TABLE inventory.movements ENABLE ROW LEVEL SECURITY;

CREATE POLICY inventory_movements_org_isolation
  ON inventory.movements
  USING (org_id::text = current_setting('app.current_org_id', true));
