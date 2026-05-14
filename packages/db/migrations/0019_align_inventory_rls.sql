-- 0019_align_inventory_rls.sql
--
-- (M3.1, 2026-05-15) Align inventory.movements + inventory.sales RLS
-- to the project-wide canonical pattern.
--
-- BACKGROUND
--   M2.0a (migration 0015) and M2.0c (migration 0017) each declared a
--   row-level security policy inline with the table creation:
--
--     CREATE POLICY inventory_movements_org_isolation ON inventory.movements
--       USING (org_id::text = current_setting('app.current_org_id', true));
--
--   That works, but two issues surfaced in the pre-launch permission
--   audit (M3.1):
--
--     1. The canonical file `900_rls_policies.sql` did NOT list these
--        two tables, so anyone reading 900 to enumerate "what's
--        RLS-protected" would (correctly!) conclude the tables had no
--        policy. The inline definition was easy to miss.
--
--     2. The inline policy is "fail-closed": if `app.current_org_id`
--        is unset, every query returns zero rows. Every other table
--        in the codebase uses a "fail-open if GUC unset" escape via
--        the `app_current_org() IS NULL` helper, on the explicit
--        rationale (see comment in 0012_rls_missing_tables.sql) that
--        single-org launch can't trigger a leak through the unset-
--        GUC path, and the app/bot/login flows that don't go through
--        `withOrgContext` would otherwise become impossible to write
--        against these tables.
--
--   M3.1 adds the two tables to 900_rls_policies.sql under the same
--   org_isolation policy name + helper-function pattern used by every
--   other org-scoped table. After this migration both tables converge
--   on a single canonical policy and the inline ones are dropped.
--
-- SAFETY
--   Idempotent. The DROP POLICY IF EXISTS is a no-op if the policy
--   was already removed in a previous run. The new `org_isolation`
--   policy is added by `900_rls_policies.sql`, which re-runs on every
--   bootstrap, so we don't recreate it here — running 900 after this
--   migration is the canonical setup.

BEGIN;

-- Drop the fail-closed inline policies from 0015 / 0017. The canonical
-- fail-open replacement is created by 900_rls_policies.sql on the next
-- bootstrap re-run (and is added to 900 in the same M3.1 patch).
DROP POLICY IF EXISTS inventory_movements_org_isolation ON inventory.movements;
DROP POLICY IF EXISTS sales_org_isolation                 ON inventory.sales;

-- RLS itself stays enabled — only the policy is being swapped out.
-- (Re-declaring ENABLE here would be a no-op anyway.)

COMMIT;
