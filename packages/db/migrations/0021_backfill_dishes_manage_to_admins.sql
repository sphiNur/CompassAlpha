-- 0021_backfill_dishes_manage_to_admins.sql
--
-- (M3.2 follow-up, 2026-05-15) Backfill `dishes.manage` onto admin
-- and super_admin roles for every existing org.
--
-- BACKGROUND
--   M3.2's first pass (migration 0020) demoted `dishes.manage` from
--   the manager role. Production audit immediately surfaced that this
--   was insufficient: the `requireDishesManage` gate accepts either
--   `dishes.manage` OR `users.manage`, and manager (rank 60) holds
--   `users.manage` per M1.9's "store manager invites their own staff"
--   design. So manager could still write to the org-wide dishes
--   table via the OR-fallback.
--
--   Two fixes land together:
--     (a) THIS migration grants `dishes.manage` explicitly to admin +
--         super_admin in every existing org. New orgs already get
--         this perm via the seed's ALL_PERMISSION_KEYS expansion;
--         the audit only flagged it as missing because pre-M2.0b
--         orgs predate the permission key.
--     (b) The next commit drops the `|| users.manage` fallback from
--         `requireDishesManage` in dishes.ts. After (a) lands, admin
--         and super_admin still pass via the explicit grant; manager
--         starts getting FORBIDDEN — which is the intended behaviour.
--
-- SAFETY
--   Idempotent — ON CONFLICT DO NOTHING. The permission key itself
--   already exists in auth.permissions (inserted in M2.0b migration);
--   no upsert needed.

BEGIN;

-- Super_admin: every org's super_admin role gets dishes.manage.
INSERT INTO auth.role_permissions (role_id, permission_key)
SELECT r.id, 'dishes.manage'
FROM auth.roles r
WHERE r.slug = 'super_admin'
ON CONFLICT DO NOTHING;

-- Admin: same for the admin role.
INSERT INTO auth.role_permissions (role_id, permission_key)
SELECT r.id, 'dishes.manage'
FROM auth.roles r
WHERE r.slug = 'admin'
ON CONFLICT DO NOTHING;

-- Safety check: we should now have at least 1 super_admin and 1 admin
-- binding for the perm. If the assertion fails the deploy aborts,
-- preventing the requireDishesManage tightening in the next commit
-- from locking out real admins.
DO $$
DECLARE
  super_count int;
  admin_count int;
BEGIN
  SELECT count(*)
    INTO super_count
    FROM auth.role_permissions rp
    JOIN auth.roles r ON r.id = rp.role_id
    WHERE rp.permission_key = 'dishes.manage' AND r.slug = 'super_admin';
  SELECT count(*)
    INTO admin_count
    FROM auth.role_permissions rp
    JOIN auth.roles r ON r.id = rp.role_id
    WHERE rp.permission_key = 'dishes.manage' AND r.slug = 'admin';
  IF super_count = 0 THEN
    RAISE EXCEPTION 'M3.2 backfill failed: no super_admin role has dishes.manage';
  END IF;
  IF admin_count = 0 THEN
    RAISE EXCEPTION 'M3.2 backfill failed: no admin role has dishes.manage';
  END IF;
END $$;

COMMIT;
