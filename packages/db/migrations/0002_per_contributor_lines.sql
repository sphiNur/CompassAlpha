-- 0002_per_contributor_lines.sql
--
-- Issue #7 fix: when two staff at the same store both add the same SKU
-- to the day's order, their qtys must NOT overwrite each other. The
-- shopping list logic for a multi-person store should be additive —
-- if A says "3 apples" and B says "2 apples" the run buys 5, not 2.
--
-- Schema change:
--   - order_items_v PK becomes (session_id, sku_id, contributor_member_id)
--     so each contributor gets their own row per SKU.
--   - The "createdBy" / "updatedBy" pair from 0001 collapses: there's
--     only one row per (session, sku, member), and that row's author
--     IS the contributor. We rename created_by_member_id →
--     contributor_member_id (keep updated_by_member_id for the manager-
--     override case) and drop the no-longer-meaningful timestamps split.
--
-- IDEMPOTENCY (added 2026-05-03 after a prod incident):
--   The original version of this migration TRUNCATEd order data and
--   then unconditionally added the new PK. That worked the first time
--   but blew up on every retry — both because (a) a re-truncate would
--   wipe production orders, and (b) ADD CONSTRAINT order_items_v_pkey
--   fails when a different-named PK is already present from the prior
--   successful run. The drizzle migrator considered the migration not
--   applied (no row in __drizzle_migrations matching the file hash)
--   and kept retrying; the failure cascaded and blocked 0003, which
--   meant `display_name_locked` never landed and sign-in broke.
--
--   This file is now safe to re-run against any DB:
--   - If the new column doesn't exist yet → do the original destructive
--     migration (TRUNCATE + reshape).
--   - If the new column already exists → no-op (skip the destructive
--     parts entirely; the schema is already where we want it).

DO $$
DECLARE
  has_contributor_col boolean;
  existing_pk_name text;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'read_model'
      AND table_name = 'order_items_v'
      AND column_name = 'contributor_member_id'
  ) INTO has_contributor_col;

  IF NOT has_contributor_col THEN
    -- Pre-0002 shape. The destructive reshape is safe to run because
    -- by definition we haven't deployed the per-contributor logic yet,
    -- so any rows present are write-only test fixtures.
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

    -- Drop whatever PK the table currently has. We can't hard-code the
    -- name because earlier drizzle versions sometimes generated PKs
    -- with synthetic names — `DROP CONSTRAINT IF EXISTS order_items_v_pkey`
    -- would silently skip such cases and leave a duplicate PK conflict.
    SELECT conname INTO existing_pk_name
    FROM pg_constraint
    WHERE conrelid = 'read_model.order_items_v'::regclass
      AND contype = 'p';
    IF existing_pk_name IS NOT NULL THEN
      EXECUTE 'ALTER TABLE read_model.order_items_v DROP CONSTRAINT '
        || quote_ident(existing_pk_name);
    END IF;

    ALTER TABLE read_model.order_items_v
      ADD COLUMN contributor_member_id uuid;

    -- Empty after truncate, so NOT NULL is safe.
    ALTER TABLE read_model.order_items_v
      ALTER COLUMN contributor_member_id SET NOT NULL;

    ALTER TABLE read_model.order_items_v
      ADD CONSTRAINT order_items_v_pkey
      PRIMARY KEY (session_id, sku_id, contributor_member_id);

    ALTER TABLE read_model.order_items_v
      DROP COLUMN IF EXISTS created_by_member_id;

    DROP INDEX IF EXISTS read_model.oiv_created_by_idx;
  END IF;
END $$;

-- Idempotent — fine to run regardless of whether the destructive block
-- above ran. CREATE INDEX IF NOT EXISTS is safe.
CREATE INDEX IF NOT EXISTS oiv_contributor_idx
  ON read_model.order_items_v (session_id, contributor_member_id);
