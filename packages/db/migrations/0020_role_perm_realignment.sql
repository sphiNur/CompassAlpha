-- 0020_role_perm_realignment.sql
--
-- (M3.2, 2026-05-15) Role/permission re-alignment driven by the pre-
-- launch architecture audit. Two cross-store leaks to close, executed
-- in one transaction.
--
-- FIX #1 — `dishes.manage` is org-wide BUT manager (rank 60) has it.
--   Manager is a store-tier role; the dishes/recipe catalog is org-
--   wide; a store manager editing a recipe silently changes how
--   EVERY OTHER store deducts ingredient inventory at sale time.
--   That's a cross-store write the store-tier role must not own.
--
--   Action: delete (manager_role_id, 'dishes.manage') from every org.
--   Admin + super_admin retain the perm (they have it via the
--   ALL_PERMISSION_KEYS expansion). A future `org_chef` builtin role
--   (M3.3) will own it for orgs that want to delegate menu work
--   without giving full admin authority.
--
-- FIX #2 — `run.create` is held by purchaser (rank 40, store-tier),
--   but `run.previewCreatable` and `run.create` query the org's
--   approved sessions WITHOUT filtering by the actor's store binding.
--   A purchaser bound to Store A could see and include sessions from
--   Stores B, C, D, E in their run plan. That's a cross-store read
--   the role binding promises to prevent.
--
--   Action: introduce a NEW permission key `run.create.org` that
--   gates the org-wide path. Grant it to admin + super_admin in
--   every existing org. The run.ts query handlers (in the same
--   commit) check for this perm (or `users.manage`) to decide
--   whether to filter by getActorStoreIds(). Existing purchaser
--   bindings keep `run.create` — they now see only sessions from
--   stores they're bound to.
--
-- SAFETY
--   All statements are idempotent. The DELETE is a no-op if the
--   binding never existed (some orgs may have already revoked it
--   manually). The permission INSERT uses ON CONFLICT DO NOTHING
--   so re-runs won't error. The role_permissions INSERTs likewise.

BEGIN;

-- ── FIX #1: revoke dishes.manage from every org's manager role ───
-- The role is keyed by (org_id, 'manager') — built-in slug. Loop is
-- not needed; one DELETE with a join handles it.

DELETE FROM auth.role_permissions rp
USING auth.roles r
WHERE rp.role_id = r.id
  AND r.slug = 'manager'
  AND rp.permission_key = 'dishes.manage';

-- ── FIX #2: register `run.create.org` and grant to admin/super_admin

-- Add the new permission key to the catalog. ON CONFLICT is required
-- because the seed run on a fresh DB inserts this key first via
-- seed-data.ts; the migration must not double-insert.
INSERT INTO auth.permissions (key, description)
VALUES (
  'run.create.org',
  'Plan a market run across the entire org (head purchaser)'
)
ON CONFLICT (key) DO NOTHING;

-- Grant to every org's super_admin role.
INSERT INTO auth.role_permissions (role_id, permission_key)
SELECT r.id, 'run.create.org'
FROM auth.roles r
WHERE r.slug = 'super_admin'
ON CONFLICT DO NOTHING;

-- Grant to every org's admin role.
INSERT INTO auth.role_permissions (role_id, permission_key)
SELECT r.id, 'run.create.org'
FROM auth.roles r
WHERE r.slug = 'admin'
ON CONFLICT DO NOTHING;

COMMIT;
