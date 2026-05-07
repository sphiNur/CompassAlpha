-- 0012_rls_missing_tables.sql
--
-- (M1.9 hardening, 2026-05-07) Add Row-Level Security to four tables
-- that the launch readiness audit flagged as missing. None of them
-- are reachable via app code that bypasses `withOrgContext`, so this
-- is defense-in-depth — a future query that forgets to scope by
-- org_id would have leaked across tenants. With these policies the
-- DB stops the leak even when the app code is wrong.
--
-- Tables covered:
--   1. auth.member_store_assignments — piggyback via auth.members.org_id
--      (no own org_id; the row is per-(member, store)).
--   2. auth.member_permission_overrides — same piggyback.
--   3. domain.policy_decisions — has its own org_id column (audit log
--      writes a row per admin action with the actor's orgId).
--   4. domain.snapshots — piggyback via domain.events.org_id
--      (lookup the first event of the stream; stream_id is the same
--      as that event's stream_id by construction).
--
-- Tables we do NOT add RLS to (intentional, see 900_rls_policies.sql):
--   - auth.users / auth.refresh_tokens — global registry; API
--     enforces user_id = ctx.userId.
--   - ops.client_logs / ops.web_push_subscriptions — user-scoped, same.
--   - sync.outbox / sync.idempotency_keys — infrastructure plumbing,
--     accessed only by the worker which trusts itself.
--   - domain.projector_cursors — singleton per projector, no org
--     dimension at all (one row per worker name).
--
-- Same fail-open pattern as the original RLS layer: when the GUC
-- `app.current_org_id` is unset (NULL), the policy lets the query
-- through. This matches existing tables and keeps the auth/login
-- path (which runs without `withOrgContext`) functional. Tightening
-- to fail-closed + lifting bypass paths to a BYPASSRLS role is a
-- separate M2 task — single-org launch can't trigger the leak this
-- defends against, but architecturally it's a known debt.
--
-- Idempotent: each ALTER + DROP POLICY + CREATE POLICY can re-run
-- safely.

BEGIN;

-- 1. auth.member_store_assignments
--    No org_id column; piggyback via the member.
ALTER TABLE auth.member_store_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON auth.member_store_assignments;
CREATE POLICY org_isolation ON auth.member_store_assignments
  USING (
    app_current_org() IS NULL
    OR EXISTS (
      SELECT 1 FROM auth.members m
      WHERE m.id = member_store_assignments.member_id
        AND m.org_id = app_current_org()
    )
  );

-- 2. auth.member_permission_overrides
--    No org_id column; piggyback via the member.
ALTER TABLE auth.member_permission_overrides ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON auth.member_permission_overrides;
CREATE POLICY org_isolation ON auth.member_permission_overrides
  USING (
    app_current_org() IS NULL
    OR EXISTS (
      SELECT 1 FROM auth.members m
      WHERE m.id = member_permission_overrides.member_id
        AND m.org_id = app_current_org()
    )
  );

-- 3. domain.policy_decisions
--    Has its own org_id column — direct compare, no join.
ALTER TABLE domain.policy_decisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON domain.policy_decisions;
CREATE POLICY org_isolation ON domain.policy_decisions
  USING (
    org_id = app_current_org()
    OR app_current_org() IS NULL
  );

-- 4. domain.snapshots
--    Stream-keyed but org boundary is the parent event's org_id. The
--    stream_id matches at least one event in domain.events, which
--    DOES have org_id and is itself RLS-protected.
ALTER TABLE domain.snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON domain.snapshots;
CREATE POLICY org_isolation ON domain.snapshots
  USING (
    app_current_org() IS NULL
    OR EXISTS (
      SELECT 1 FROM domain.events e
      WHERE e.stream_id = snapshots.stream_id
        AND e.org_id = app_current_org()
      LIMIT 1
    )
  );

COMMIT;
