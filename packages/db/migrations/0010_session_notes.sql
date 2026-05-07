-- 0010_session_notes.sql
--
-- (M1.8, 2026-05-07) Free-text "其他物品" / "miscellaneous items" note
-- per order session.
--
-- Why: staff regularly want items not in the SKU catalog (one-off
-- holidays, supplier-specific weird stuff, "buy whatever bread looks
-- fresh"). Adding to the catalog for one shopping trip is too heavy.
-- A free-text note attached to the session lets the manager see the
-- request during approval and the purchaser see it in the run preview
-- without polluting the SKU master list.
--
-- One column on order_sessions_v is enough: only the SESSION OWNER
-- writes here (same edit gate as line items), it's a single string
-- (last-write-wins, no history beyond the event log), and we want it
-- nullable so the existing UIs can no-op when empty.
--
-- 1000-char ceiling enforced in the domain layer (commands.ts), not in
-- the column type — text() lets us raise the cap without a migration
-- if we ever decide a longer note is fine.

BEGIN;

ALTER TABLE read_model.order_sessions_v
  ADD COLUMN IF NOT EXISTS notes text;

COMMIT;
