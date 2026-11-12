-- 0071_outbox_notifications_audit_indexes.sql
--
-- Reviews COREAPI-22 and DB-11 (2026-11-12). Three reads that grow with
-- the tables had no index to use:
--
--   1. The worker takes the oldest due outbox row (`sent_at IS NULL AND
--      next_attempt_at <= now() ORDER BY created_at LIMIT 1`), up to 50
--      times a pass, and system.health counts the unsent rows. The only
--      index was on next_attempt_at, which every delivered row (kept 30
--      days) also passes, so each take read them all and sorted. The new
--      index holds the unsent rows only, in created_at order.
--   2. The hourly retention deletes ops.notifications by created_at; the
--      only index on it starts with recipient_user_id.
--   3. The admin audit list reads `org_id = $1 ORDER BY occurred_at DESC
--      LIMIT n` from domain.policy_decisions, which is never trimmed. Its
--      indexes start with actor_id or action, or hold only the rows with
--      a store (policy_dec_store_idx), so an organisation admin's list
--      read the whole table and sorted it.
--
-- Plain CREATE INDEX: the runner applies migrations in a transaction, and
-- the tables are small enough that their write lock is held for a moment
-- only.

CREATE INDEX IF NOT EXISTS outbox_unsent_idx ON sync.outbox (created_at) WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS notif_created_idx ON ops.notifications (created_at);
CREATE INDEX IF NOT EXISTS policy_dec_org_idx ON domain.policy_decisions (org_id, occurred_at);
