-- 0005_per_member_sessions.sql
--
-- Reverts the 0001 design back to per-member ownership of sessions.
--
-- Background:
--   0000 — original per-(member, store, date) keying
--   0001 — collapsed to per-(store, date) so multiple staff at the same
--           store could collaborate on ONE shopping list
--   0002 — added contributor_member_id to order_items_v so two staff
--           adding the same SKU don't overwrite each other
--   0005 (this) — customer feedback (2026-05-04): "shared list is
--           confusing — staff shouldn't see each other's items".
--           Restore per-member ownership while KEEPING the 0002
--           per-contributor item structure (which is now functionally
--           per-session since each session has a single owner).
--
-- Behavioral effect after this migration:
--   - Each (org, store, member, date) gets its own session.
--   - Multiple staff at the same store can each draft + submit
--     independently.
--   - Manager (Approval page) sees ALL submitted sessions per store
--     per day and reviews each separately.
--   - Run planning still aggregates across all approved sessions.
--
-- Idempotent: drops the (org, store, date) unique index, replaces
-- with (org, store, owner, date). The new index is STRICTLY MORE
-- PERMISSIVE — every existing row already satisfies it (since each
-- old session has exactly one initiated_by_member_id), so no data
-- conflict on apply.

-- Step 1: drop the per-store unique index.
DROP INDEX IF EXISTS read_model.osv_org_store_date_unique;

-- Step 2: add the per-(member, store, date) unique index.
-- `initiated_by_member_id` was always populated by `DraftStarted`
-- since 0001, so we don't need a NOT NULL constraint backfill.
-- Postgres unique indexes treat NULL as distinct, but since every
-- existing row has a non-null owner, that quirk doesn't bite us.
CREATE UNIQUE INDEX IF NOT EXISTS osv_org_store_member_date_unique
  ON read_model.order_sessions_v (org_id, store_id, initiated_by_member_id, order_date);
