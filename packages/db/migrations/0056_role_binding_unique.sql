-- 0056_role_binding_unique.sql
--
-- RE-ADM-1 (2026-10-31): auth.member_role_bindings had no unique index,
-- so four concurrent invites of the same person wrote four identical
-- bindings (grantRole serialises itself with an advisory lock; the invite
-- paths did not). This removes the exact duplicates already there and
-- then lets the table refuse new ones; the application inserts with
-- ON CONFLICT DO NOTHING.
--
-- What counts as a duplicate: the same member, role, scope type and
-- scope id (a global binding's NULL scope id counts as equal). Of each
-- group the earliest row (created_at, then id) stays. Its expiry is
-- widened to the most generous one in the group — no expiry if any row
-- had none — so nobody loses access they had through a removed copy.
-- Each removed row is recorded in the admin audit
-- (domain.policy_decisions, action 'admin.role.dedupe'); existing audit
-- rows are not touched.
--
-- SAFETY: runs without manual steps on any data. Both tables are under
-- FORCE RLS, so the system context is declared first (transaction-local,
-- like 0051). The table is locked against writes for the few statements
-- below so no new duplicate can slip in between the clean-up and the
-- index. Idempotent: a second run finds no duplicates and the index
-- exists. NULLS NOT DISTINCT needs Postgres 15+ (production runs 16).
SELECT set_config('app.system_context', 'maintenance', true);
--> statement-breakpoint
LOCK TABLE auth.member_role_bindings IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TEMP TABLE mrb_dedupe ON COMMIT DROP AS
SELECT b.id,
       b.member_id,
       b.role_id,
       b.scope_type,
       b.scope_id,
       r.org_id,
       first_value(b.id) OVER w AS keep_id,
       row_number() OVER w AS rn,
       bool_or(b.expires_at IS NULL) OVER g AS any_forever,
       max(b.expires_at) OVER g AS latest_expiry,
       count(*) OVER g AS n
FROM auth.member_role_bindings b
JOIN auth.roles r ON r.id = b.role_id
WINDOW w AS (PARTITION BY b.member_id, b.role_id, b.scope_type, b.scope_id
             ORDER BY b.created_at, b.id),
       g AS (PARTITION BY b.member_id, b.role_id, b.scope_type, b.scope_id);
--> statement-breakpoint
UPDATE auth.member_role_bindings b
SET expires_at = CASE WHEN d.any_forever THEN NULL ELSE d.latest_expiry END
FROM mrb_dedupe d
WHERE b.id = d.id
  AND d.rn = 1
  AND d.n > 1
  AND b.expires_at IS DISTINCT FROM (CASE WHEN d.any_forever THEN NULL ELSE d.latest_expiry END);
--> statement-breakpoint
INSERT INTO domain.policy_decisions
  (org_id, actor_id, action, resource_type, resource_id, decision, reason, inputs, scope_store_id)
SELECT d.org_id,
       NULL,
       'admin.role.dedupe',
       'member',
       d.member_id,
       'allow',
       'migration 0056: removed a duplicate role binding',
       jsonb_build_object(
         'bindingId', d.id,
         'keptBindingId', d.keep_id,
         'roleId', d.role_id,
         'scopeType', d.scope_type,
         'scopeId', d.scope_id
       ),
       CASE WHEN d.scope_type = 'store' THEN d.scope_id ELSE NULL END
FROM mrb_dedupe d
WHERE d.rn > 1;
--> statement-breakpoint
DELETE FROM auth.member_role_bindings b
USING mrb_dedupe d
WHERE b.id = d.id
  AND d.rn > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS mrb_binding_unique
  ON auth.member_role_bindings (member_id, role_id, scope_type, scope_id) NULLS NOT DISTINCT;
