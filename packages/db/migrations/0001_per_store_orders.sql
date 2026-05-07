-- 0001_per_store_orders.sql
--
-- Schema change: shift the order session model from PER-MEMBER (one
-- session per (org, store, member, date)) to PER-STORE (one session
-- per (org, store, date), shared by every staff member at that store).
--
-- New behavior:
--   - Multiple staff at the same store contribute line items to ONE
--     shared shopping list.
--   - Each line item carries `created_by_member_id` and
--     `updated_by_member_id`, so we know who put what in.
--   - Default editing privilege: only the original creator OR a member
--     with `order.approve` permission (the "store manager") can edit
--     a given line. Server-side enforced.
--
-- IDEMPOTENCY (added 2026-05-03 alongside 0002 hardening):
--   The original version unconditionally TRUNCATEd order data. If the
--   drizzle migrator ever loses track of which migrations are applied
--   (e.g. __drizzle_migrations table out of sync, journal manually
--   edited) and re-runs this file, an unconditional TRUNCATE would
--   wipe live order history. Gate the destructive part on whether the
--   schema is still in pre-0001 shape (member_id column still exists
--   on order_sessions_v).

DO $$
DECLARE
  is_pre_0001 boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'read_model'
      AND table_name = 'order_sessions_v'
      AND column_name = 'member_id'
  ) INTO is_pre_0001;

  IF is_pre_0001 THEN
    -- Pre-0001 shape. TRUNCATE is safe — these are pre-multi-staff rows
    -- and there's no migration path forward for the old keying.
    TRUNCATE TABLE
      read_model.run_item_stores_v,
      read_model.run_items_v,
      read_model.market_runs_v,
      read_model.order_items_v,
      read_model.order_sessions_v,
      domain.snapshots,
      domain.events,
      domain.policy_decisions,
      inventory.price_history,
      ops.notifications,
      sync.outbox
    RESTART IDENTITY CASCADE;

    ALTER TABLE read_model.order_sessions_v
      DROP COLUMN IF EXISTS member_id;
    DROP INDEX IF EXISTS read_model.osv_org_store_member_date_idx;
  END IF;
END $$;

-- The column adds + index creates below are already idempotent. Safe
-- to run on both pre-0001 (after the DO block has cleared member_id)
-- and post-0001 schemas.
ALTER TABLE read_model.order_sessions_v
  ADD COLUMN IF NOT EXISTS initiated_by_member_id uuid;
ALTER TABLE read_model.order_sessions_v
  ADD COLUMN IF NOT EXISTS submitted_by_member_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS osv_org_store_date_unique
  ON read_model.order_sessions_v (org_id, store_id, order_date);

ALTER TABLE read_model.order_items_v
  DROP COLUMN IF EXISTS last_edited_by_user_id;
ALTER TABLE read_model.order_items_v
  DROP COLUMN IF EXISTS last_edited_at;

ALTER TABLE read_model.order_items_v
  ADD COLUMN IF NOT EXISTS created_by_member_id uuid;
ALTER TABLE read_model.order_items_v
  ADD COLUMN IF NOT EXISTS updated_by_member_id uuid;
ALTER TABLE read_model.order_items_v
  ADD COLUMN IF NOT EXISTS created_at timestamp with time zone;
ALTER TABLE read_model.order_items_v
  ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS oiv_created_by_idx
  ON read_model.order_items_v (session_id, created_by_member_id);
