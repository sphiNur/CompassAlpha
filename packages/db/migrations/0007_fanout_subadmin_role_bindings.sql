-- 0007_fanout_subadmin_role_bindings.sql
--
-- Background — pre-2026-05-05, `admin.grantRole` and
-- `admin.memberInviteByTgId` happily created `scope_type='global'`
-- bindings even for sub-admin roles (manager, purchaser, staff). The
-- runtime would then carry "this manager works at every store" through
-- to the queue queries — exactly the cross-store leak the audit caught.
--
-- 2026-05-05 made the API refuse to create global bindings for any role
-- with rank < 80 (admin-tier). This migration cleans up the historical
-- residue: every existing global binding for a sub-admin role is
-- fanned out into one store-scoped binding per the member's
-- `member_store_assignments`, then the original global row is deleted.
--
-- Idempotent. Re-running after the first apply finds no global
-- sub-admin bindings to fan out.
--
-- Ordering matters: insert the per-store rows first so a crash mid-way
-- still leaves the actor with their original global binding intact.

BEGIN;

-- Step 1: For every (member, role) where the binding is global AND the
-- role rank is < 80, insert one store-scoped binding per store the
-- member is assigned to via member_store_assignments.
INSERT INTO auth.member_role_bindings (
  id, member_id, role_id, scope_type, scope_id, granted_by, expires_at, created_at
)
SELECT
  gen_random_uuid(),
  mrb.member_id,
  mrb.role_id,
  'store',
  msa.store_id,
  mrb.granted_by,
  mrb.expires_at,
  NOW()
FROM auth.member_role_bindings mrb
JOIN auth.roles r ON r.id = mrb.role_id
JOIN auth.member_store_assignments msa ON msa.member_id = mrb.member_id
WHERE mrb.scope_type = 'global'
  AND r.rank < 80
  -- Defensive: don't double-insert if a store-scoped row already exists.
  AND NOT EXISTS (
    SELECT 1 FROM auth.member_role_bindings existing
    WHERE existing.member_id = mrb.member_id
      AND existing.role_id   = mrb.role_id
      AND existing.scope_type = 'store'
      AND existing.scope_id  = msa.store_id
  );

-- Step 2: Delete the now-redundant global bindings for sub-admin roles.
-- Drop only after the per-store rows landed in Step 1.
DELETE FROM auth.member_role_bindings mrb
USING auth.roles r
WHERE r.id = mrb.role_id
  AND mrb.scope_type = 'global'
  AND r.rank < 80;

COMMIT;
