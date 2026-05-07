-- 0009_store_default_role_and_audit_scope.sql
--
-- Two unrelated additions bundled in one migration to avoid a deploy
-- where one ships and the other lags:
--
-- (D3, 2026-05-06) inventory.stores.default_role_id
--   Each store can declare a "when a new member is invited HERE without
--   a role chosen, fall back to this role" default. Used by the invite
--   path to remove a click; UI exposes the dropdown in the store edit
--   form. Nullable — a store with no default behaves exactly like
--   today's invite path (operator must pick a role explicitly).
--
--   ON DELETE SET NULL: deleting a role doesn't break stores that point
--   at it; they just revert to "no default". Cascading or restricting
--   would surprise admins ("I can't delete this role because store X
--   uses it as a default? Why?").
--
-- (B2, 2026-05-06) domain.policy_decisions.scope_store_id + index
--   So the audit log can be filtered "show me everything that happened
--   in Store A". The auditAdmin() helper is being extended to derive
--   this from the inputs payload (storeId / scopeId / fromStoreId /
--   toStoreId — whichever is most natural per action). Old rows stay
--   NULL — historical audit pre-2026-05-06 just won't appear in the
--   filter, which is fine.

BEGIN;

-- ===== D3 =====

ALTER TABLE inventory.stores
  ADD COLUMN IF NOT EXISTS default_role_id uuid
    REFERENCES auth.roles(id) ON DELETE SET NULL;

-- Operational: lookup "which stores fall back to this role" if an admin
-- ever wants to tidy up. Tiny table so the cost is negligible.
CREATE INDEX IF NOT EXISTS stores_default_role_idx
  ON inventory.stores (default_role_id)
  WHERE default_role_id IS NOT NULL;

-- ===== B2 =====

ALTER TABLE domain.policy_decisions
  ADD COLUMN IF NOT EXISTS scope_store_id uuid;

-- The audit-list query joins by (org_id, occurred_at) and now
-- optionally filters by scope_store_id. A partial index keeps writes
-- cheap and reads fast for the common "show me Store A's recent
-- changes" case.
CREATE INDEX IF NOT EXISTS policy_dec_store_idx
  ON domain.policy_decisions (org_id, scope_store_id, occurred_at)
  WHERE scope_store_id IS NOT NULL;

COMMIT;
