-- 0026_order_session_partial_unique.sql
--
-- (M3.32, 2026-05-18) Allow multiple order sessions per (member, store,
-- date) by relaxing the unique constraint to apply ONLY to draft rows.
--
-- BACKGROUND
--   The unique index introduced in 0005 keyed on
--     (org_id, store_id, initiated_by_member_id, order_date)
--   unconditionally — once a staff member submitted an order for a
--   given (store, date), they could never start a second batch that
--   day. AdjustItem's lazy-create would crash with a unique-violation
--   if they tried (PG error 23505). The architectural review with the
--   user surfaced this as a real-world friction: kitchens want to
--   submit a morning order, then add a midday top-up, then maybe a
--   late-afternoon staple refresh. Each batch should flow through
--   approval independently; the purchaser sees them aggregated via
--   run.previewCreatable.
--
-- WHY PARTIAL, NOT TOTAL DROP
--   We still want exactly ONE draft per (member, store, date) — if
--   the user can have two open drafts, the OrderPage doesn't know
--   which to land their +/- taps on, and the lazy-create on
--   AdjustItem can't pick a winner. With the partial index, "draft"
--   stays unique; everything else (submitted, approved, rejected,
--   in_run, archived) is unbounded.
--
-- SAFETY
--   Idempotent (IF EXISTS / IF NOT EXISTS). Index swap is online —
--   PG creates the new partial index, drops the old one, no table
--   lock past a brief metadata-only catalog update.

BEGIN;

DROP INDEX IF EXISTS read_model.osv_org_store_member_date_unique;

CREATE UNIQUE INDEX IF NOT EXISTS osv_org_store_member_date_draft_unique
  ON read_model.order_sessions_v (org_id, store_id, initiated_by_member_id, order_date)
  WHERE status = 'draft';

COMMIT;
