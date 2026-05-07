-- 0004_role_rank_and_granular_perms.sql
--
-- Multi-tenant SaaS hardening, round 1 (2026-05-03):
--
--   1. `auth.roles.rank smallint` — numeric power level so the API
--      can enforce "no equal/higher grants" without hard-coding the
--      role hierarchy in app code. Built-in ranks:
--          super_admin = 100
--          admin       =  80
--          manager     =  60
--          purchaser   =  40
--          staff       =  20
--      Custom roles created by an org admin live in the gaps.
--
--   2. New permission keys split out of the previous coarse `users.manage`:
--          users.grant_role
--          users.revoke_role
--          users.assign_store
--      Only super_admin gets all three by seed; other built-in roles
--      keep `users.manage` for backwards-compatibility but the server
--      check is now: `has(any of granular keys) OR has('users.manage')`.
--
-- Backfill is idempotent. ALTER TABLE adds NOT NULL with default 0;
-- the UPDATE then sets ranks for the built-in slugs across every org.

ALTER TABLE auth.roles
  ADD COLUMN IF NOT EXISTS rank integer NOT NULL DEFAULT 0;

UPDATE auth.roles SET rank = 100 WHERE slug = 'super_admin' AND rank = 0;
UPDATE auth.roles SET rank =  80 WHERE slug = 'admin'       AND rank = 0;
UPDATE auth.roles SET rank =  60 WHERE slug = 'manager'     AND rank = 0;
UPDATE auth.roles SET rank =  40 WHERE slug = 'purchaser'   AND rank = 0;
UPDATE auth.roles SET rank =  20 WHERE slug = 'staff'       AND rank = 0;

-- Granular grant permissions. The `INSERT … ON CONFLICT DO NOTHING`
-- pattern makes this safe to re-run without duplicates.
INSERT INTO auth.permissions (key, description) VALUES
  ('users.grant_role',  'Grant a role to a member (rank-gated)'),
  ('users.revoke_role', 'Revoke a role from a member'),
  ('users.assign_store','Assign a member to a store')
ON CONFLICT (key) DO NOTHING;

-- Wire the new permissions to super_admin in every org. (Other roles
-- continue to rely on `users.manage` for now; admins of an org can
-- explicitly grant the granular keys to a custom role if they want
-- that finer split.)
INSERT INTO auth.role_permissions (role_id, permission_key)
SELECT r.id, k.key
FROM auth.roles r
CROSS JOIN (VALUES
  ('users.grant_role'),
  ('users.revoke_role'),
  ('users.assign_store')
) AS k(key)
WHERE r.slug = 'super_admin'
ON CONFLICT (role_id, permission_key) DO NOTHING;
