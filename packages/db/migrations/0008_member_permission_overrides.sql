-- 0008_member_permission_overrides.sql
--
-- Per-member permission overrides (added 2026-05-05).
--
-- Use case from the user: "two staff have the same role, but one of
-- them is the senior who also approves orders". The role catalog
-- defines the baseline; this table layers additive `allow` /
-- destructive `deny` exceptions on top, scoped globally OR to a
-- specific store.
--
-- Resolution order at session-build time:
--   1. Start with the union of role-derived permission keys.
--   2. Apply 'allow' overrides — adds keys (no-op if already present).
--   3. Apply 'deny'  overrides — removes keys.
-- So `deny` always wins ties (a senior can be denied a permission their
-- role normally grants).
--
-- Why a new table instead of reusing auth.policy_rules:
--   policy_rules carries CEL/expression strings (`subject_expr`,
--   `resource_expr`) that nobody ever wired up. Reusing it for the
--   simple key-allow/deny case would either drag in the unused engine
--   or pollute it with a sentinel encoding. Cleaner to keep this
--   table small and focused. policy_rules stays parked for future ABAC.
--
-- Scope:
--   scope_type='global' + scope_id=NULL  → applies anywhere the
--                                          permission is checked
--   scope_type='store'  + scope_id=<id>  → applies only when the
--                                          actor is operating on that
--                                          store. The session-build
--                                          path doesn't yet branch
--                                          on this — it stamps the
--                                          permissions globally for
--                                          M0 simplicity. Per-store
--                                          enforcement lands in M1.
--
-- PRIMARY KEY: (member_id, permission_key, scope_type, scope_id) —
-- but scope_id can be NULL, which Postgres treats as distinct in
-- unique constraints. We coerce NULL to '00000000-0000-0000-0000-000000000000'
-- via COALESCE in a unique index to make idempotent upserts safe.

CREATE TABLE IF NOT EXISTS auth.member_permission_overrides (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id       uuid NOT NULL REFERENCES auth.members(id) ON DELETE CASCADE,
  permission_key  varchar(100) NOT NULL REFERENCES auth.permissions(key) ON DELETE CASCADE,
  effect          varchar(8) NOT NULL CHECK (effect IN ('allow', 'deny')),
  scope_type      varchar(16) NOT NULL DEFAULT 'global' CHECK (scope_type IN ('global', 'store')),
  scope_id        uuid,
  granted_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- A store-scoped override must carry a scope_id; a global override
  -- must NOT. Cheap defensive constraint to catch UI bugs at insert.
  CHECK (
    (scope_type = 'global' AND scope_id IS NULL) OR
    (scope_type = 'store'  AND scope_id IS NOT NULL)
  )
);

-- Idempotency: one override per (member, permission, scope). Treat NULL
-- scope_id as a distinct sentinel so the global override is unique.
CREATE UNIQUE INDEX IF NOT EXISTS mpo_unique
  ON auth.member_permission_overrides
  (member_id, permission_key, scope_type, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Lookup index for session-build:
--   "give me every active override for member X" (left-joined into
--   the existing role-permission read).
CREATE INDEX IF NOT EXISTS mpo_member_idx
  ON auth.member_permission_overrides (member_id);

-- Operational: hint for auditing "who has this permission overridden
-- across the org". Cheap because the table will stay small.
CREATE INDEX IF NOT EXISTS mpo_perm_idx
  ON auth.member_permission_overrides (permission_key);
