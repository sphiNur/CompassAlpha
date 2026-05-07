-- 0011_manager_users_manage.sql
--
-- (M1.9, 2026-05-07) Per-store admin invite gap fix.
--
-- The default `manager` role (rank=60, slug='manager', built-in) was
-- seeded without `users.manage`, so per-store managers passed neither
-- the FE invite-button gate nor the server's `requireAdmin` check —
-- effectively only org-wide admins could invite anyone, contradicting
-- the per-store collaborative model added in M1.6 (where the cross-
-- store gate `getActorAdminStoreIds` was specifically built to allow
-- store-scoped managers to invite into their own stores).
--
-- This migration is the data backfill that matches the seed-data.ts
-- update. New orgs created after this point pick up the perm via the
-- seed; existing orgs (incl. prod) need this row inserted.
--
-- The cross-store guard (admin.ts ~887) still prevents a manager-of-A
-- from inviting into B, so granting the broad `users.manage` is safe
-- as long as the FE conditionally hides org-wide actions (RoleCreate,
-- TransferStore, etc.) from non-global-admins. That UI tightening
-- ships in a separate FE-only patch.
--
-- Idempotent — `ON CONFLICT DO NOTHING` so re-runs are no-ops.

BEGIN;

INSERT INTO auth.role_permissions (role_id, permission_key)
SELECT r.id, 'users.manage'
  FROM auth.roles r
 WHERE r.slug = 'manager'
   AND r.is_built_in = true
ON CONFLICT (role_id, permission_key) DO NOTHING;

COMMIT;
