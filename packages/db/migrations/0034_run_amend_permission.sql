-- 0034_run_amend_permission.sql
--
-- (2026-07-06) Super-admin post-finish run amendment. A super-admin can
-- reopen a FINISHED run to correct it (add / remove / modify items +
-- prices) via the new run.reopen / run.refinalize flow. The gate is a
-- new permission `run.amend`, granted to super_admin ONLY — an admin can
-- configure the org but must not rewrite settled financial records.
--
-- Existing production orgs already have their built-in roles seeded, so
-- the new permission from seed-data.ts would NOT reach them without this
-- migration (deploy runs `migrate`, not `seed`). This grants it to every
-- org's super_admin role.
--
-- SAFETY: idempotent. The permission INSERT uses ON CONFLICT DO NOTHING
-- (seed-data.ts inserts the same key first on a fresh DB); the role
-- grant likewise, so re-runs are no-ops.

BEGIN;

-- Register the permission key in the catalog.
INSERT INTO auth.permissions (key, description)
VALUES ('run.amend', 'Amend a finished run (super-admin correction)')
ON CONFLICT (key) DO NOTHING;

-- Grant to every org's super_admin role ONLY (not admin).
INSERT INTO auth.role_permissions (role_id, permission_key)
SELECT r.id, 'run.amend'
FROM auth.roles r
WHERE r.slug = 'super_admin'
ON CONFLICT DO NOTHING;

COMMIT;
