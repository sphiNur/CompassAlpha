-- 0022_org_admin_marker.sql
--
-- (M3.3, 2026-05-15) Introduce the `org.admin` permission key as the
-- canonical "org-tier admin authority" marker, and grant it to admin
-- and super_admin in every existing org.
--
-- BACKGROUND
--   Pre-launch audit found `requireAdmin` (which checks `users.manage`)
--   is overloaded across two roles:
--     1. admin + super_admin — true org-tier admins who should be
--        able to touch org-wide entities (SKUs, suppliers, roles).
--     2. manager — store-tier role that has `users.manage` since
--        M1.9 ("store manager invites own staff for THEIR stores").
--        Cross-store gates (C2: getActorAdminStoreIds) prevent
--        manager from touching foreign-store members, but NOT from
--        touching org-wide catalog rows.
--
--   The next commit replaces `requireAdmin` with `requireOrgAdmin`
--   at 19 mutation sites that should be org-tier only (skuCreate,
--   roleCreate, supplierCreate, storeCreate/Delete, etc.). The new
--   gate checks `org.admin`, which manager never holds.
--
-- SAFETY
--   Idempotent. The new permission key is inserted with ON CONFLICT
--   DO NOTHING so re-runs don't error. The grants likewise. A
--   DO-block asserts at least one super_admin and one admin role got
--   the perm; deploy aborts if not (would lock out real admins).

BEGIN;

-- ── insert the new permission key ────────────────────────────────
INSERT INTO auth.permissions (key, description)
VALUES (
  'org.admin',
  'Org-tier administrative authority (catalog, roles, org settings)'
)
ON CONFLICT (key) DO NOTHING;

-- ── grant to every org's super_admin ─────────────────────────────
INSERT INTO auth.role_permissions (role_id, permission_key)
SELECT r.id, 'org.admin'
FROM auth.roles r
WHERE r.slug = 'super_admin'
ON CONFLICT DO NOTHING;

-- ── grant to every org's admin ───────────────────────────────────
INSERT INTO auth.role_permissions (role_id, permission_key)
SELECT r.id, 'org.admin'
FROM auth.roles r
WHERE r.slug = 'admin'
ON CONFLICT DO NOTHING;

-- ── safety assertion ─────────────────────────────────────────────
DO $$
DECLARE
  super_roles int;
  super_count int;
  admin_roles int;
  admin_count int;
  mgr_count int;
BEGIN
  SELECT count(*)
    INTO super_roles
    FROM auth.roles r
    WHERE r.slug = 'super_admin';
  SELECT count(*)
    INTO super_count
    FROM auth.role_permissions rp
    JOIN auth.roles r ON r.id = rp.role_id
    WHERE rp.permission_key = 'org.admin' AND r.slug = 'super_admin';
  SELECT count(*)
    INTO admin_roles
    FROM auth.roles r
    WHERE r.slug = 'admin';
  SELECT count(*)
    INTO admin_count
    FROM auth.role_permissions rp
    JOIN auth.roles r ON r.id = rp.role_id
    WHERE rp.permission_key = 'org.admin' AND r.slug = 'admin';
  -- Defensive: confirm no manager got org.admin by mistake. The
  -- seed never grants it; this is just paranoid double-check.
  SELECT count(*)
    INTO mgr_count
    FROM auth.role_permissions rp
    JOIN auth.roles r ON r.id = rp.role_id
    WHERE rp.permission_key = 'org.admin' AND r.slug = 'manager';
  IF super_roles > 0 AND super_count = 0 THEN
    RAISE EXCEPTION 'M3.3 backfill failed: no super_admin role has org.admin';
  END IF;
  IF admin_roles > 0 AND admin_count = 0 THEN
    RAISE EXCEPTION 'M3.3 backfill failed: no admin role has org.admin';
  END IF;
  IF mgr_count > 0 THEN
    RAISE EXCEPTION 'M3.3 backfill anomaly: % manager role(s) got org.admin', mgr_count;
  END IF;
END $$;

COMMIT;
