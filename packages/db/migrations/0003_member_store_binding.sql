-- 0003_member_store_binding.sql
--
-- Multi-store authorization (issue raised 2026-05-03):
--   - A member MUST belong to one or more stores before they can edit
--     or view that store's orders. Without this, every member of an
--     org sees every store, which crosses tenant boundaries inside a
--     single org.
--   - displayName must be confirmed by the user once at first
--     sign-in, then locked: only admins can change it later.
--
-- Schema additions (additive, NOT destructive — keeping orders/runs):
--   1. `auth.member_store_assignments(member_id, store_id, ...)` —
--      many-to-many mapping. Composite PK.
--   2. `auth.users.display_name_locked boolean default false` — set
--      true after the user completes onboarding.
--
-- Backfill strategy:
--   - For existing members: leave `member_store_assignments` empty.
--     Admins / super_admins have `users.manage` and bypass the
--     assignment check. Regular staff with no assignment will hit
--     "Ask admin to assign your store" until an admin acts.
--   - For existing users: leave `display_name_locked = false` so the
--     onboarding screen shows once on next login (idempotent — they
--     can keep their current name).

ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS display_name_locked boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS auth.member_store_assignments (
  member_id uuid NOT NULL REFERENCES auth.members(id) ON DELETE CASCADE,
  store_id  uuid NOT NULL REFERENCES inventory.stores(id) ON DELETE CASCADE,
  assigned_at timestamp with time zone NOT NULL DEFAULT now(),
  assigned_by uuid REFERENCES auth.users(id),
  PRIMARY KEY (member_id, store_id)
);

CREATE INDEX IF NOT EXISTS msa_member_idx
  ON auth.member_store_assignments (member_id);
CREATE INDEX IF NOT EXISTS msa_store_idx
  ON auth.member_store_assignments (store_id);

-- Optional convenience: backfill super_admins / admins as bypass-implicit;
-- nothing to do here, the bypass is server-side. Regular members get
-- assigned via the admin UI going forward.
