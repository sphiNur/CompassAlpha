-- Row-Level Security policies. Run AFTER drizzle-generated DDL.
-- Idempotent: each policy is dropped+recreated.

-- Helper: returns NULL if context not set, else org id as uuid.
CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid
$$ LANGUAGE SQL STABLE;

-- Org self-row policy.
ALTER TABLE auth.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.organizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_self ON auth.organizations;
CREATE POLICY org_self ON auth.organizations
  USING (id = app_current_org() OR app_current_org() IS NULL);

-- Tables with their own org_id column.
DO $$
DECLARE
  org_tables text[] := ARRAY[
    'auth.members',
    'auth.roles',
    'auth.policy_rules',
    'inventory.stores',
    'inventory.suppliers',
    'inventory.categories',
    'inventory.skus',
    'inventory.expense_templates',
    'inventory.price_history',
    'inventory.movements',
    'inventory.sales',
    'domain.events',
    'read_model.order_sessions_v',
    'read_model.market_runs_v',
    'ops.notifications',
    'ops.audit_log',
    'ops.feature_flags',
    'ops.daily_metrics'
  ];
  t text;
BEGIN
  FOREACH t IN ARRAY org_tables LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS org_isolation ON %s', t);
    EXECUTE format(
      'CREATE POLICY org_isolation ON %s USING (org_id = app_current_org() OR app_current_org() IS NULL)',
      t
    );
  END LOOP;
END $$;

-- Tables that hang off an org-scoped parent (no org_id column).
-- They piggy-back via FK lookup so the policy still enforces tenant boundary.

ALTER TABLE auth.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.role_permissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON auth.role_permissions;
CREATE POLICY org_isolation ON auth.role_permissions
  USING (
    app_current_org() IS NULL
    OR EXISTS (
      SELECT 1 FROM auth.roles r
      WHERE r.id = role_permissions.role_id AND r.org_id = app_current_org()
    )
  );

-- member_role_bindings has no org_id; piggy-back via the role's org_id.
ALTER TABLE auth.member_role_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.member_role_bindings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON auth.member_role_bindings;
CREATE POLICY org_isolation ON auth.member_role_bindings
  USING (
    app_current_org() IS NULL
    OR EXISTS (
      SELECT 1 FROM auth.roles r
      WHERE r.id = member_role_bindings.role_id AND r.org_id = app_current_org()
    )
  );

ALTER TABLE inventory.store_supplier_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.store_supplier_prefs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON inventory.store_supplier_prefs;
CREATE POLICY org_isolation ON inventory.store_supplier_prefs
  USING (
    app_current_org() IS NULL
    OR EXISTS (
      SELECT 1 FROM inventory.stores s
      WHERE s.id = store_supplier_prefs.store_id AND s.org_id = app_current_org()
    )
  );

ALTER TABLE inventory.sku_supplier_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.sku_supplier_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON inventory.sku_supplier_links;
CREATE POLICY org_isolation ON inventory.sku_supplier_links
  USING (
    app_current_org() IS NULL
    OR EXISTS (
      SELECT 1 FROM inventory.skus k
      WHERE k.id = sku_supplier_links.sku_id AND k.org_id = app_current_org()
    )
  );

ALTER TABLE read_model.order_items_v ENABLE ROW LEVEL SECURITY;
ALTER TABLE read_model.order_items_v FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON read_model.order_items_v;
CREATE POLICY org_isolation ON read_model.order_items_v
  USING (
    app_current_org() IS NULL
    OR EXISTS (
      SELECT 1 FROM read_model.order_sessions_v s
      WHERE s.id = order_items_v.session_id AND s.org_id = app_current_org()
    )
  );

ALTER TABLE read_model.run_items_v ENABLE ROW LEVEL SECURITY;
ALTER TABLE read_model.run_items_v FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON read_model.run_items_v;
CREATE POLICY org_isolation ON read_model.run_items_v
  USING (
    app_current_org() IS NULL
    OR EXISTS (
      SELECT 1 FROM read_model.market_runs_v r
      WHERE r.id = run_items_v.run_id AND r.org_id = app_current_org()
    )
  );

ALTER TABLE read_model.run_item_stores_v ENABLE ROW LEVEL SECURITY;
ALTER TABLE read_model.run_item_stores_v FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON read_model.run_item_stores_v;
CREATE POLICY org_isolation ON read_model.run_item_stores_v
  USING (
    app_current_org() IS NULL
    OR EXISTS (
      SELECT 1 FROM read_model.market_runs_v r
      WHERE r.id = run_item_stores_v.run_id AND r.org_id = app_current_org()
    )
  );

-- M1.9 (2026-05-07): four tables added later didn't make it into the
-- big DO-loop above and were missing RLS. Adding them inline so this
-- file remains the canonical source-of-truth (re-run on bootstrap).
-- The migration 0012_rls_missing_tables.sql is the data-migration
-- equivalent for orgs that were already provisioned before this fix.

ALTER TABLE auth.member_store_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.member_store_assignments FORCE ROW LEVEL SECURITY;
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

ALTER TABLE auth.member_permission_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.member_permission_overrides FORCE ROW LEVEL SECURITY;
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

ALTER TABLE domain.policy_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.policy_decisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON domain.policy_decisions;
CREATE POLICY org_isolation ON domain.policy_decisions
  USING (
    org_id = app_current_org()
    OR app_current_org() IS NULL
  );

ALTER TABLE domain.snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain.snapshots FORCE ROW LEVEL SECURITY;
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

-- User-scoped tables (auth.users, auth.refresh_tokens, ops.web_push_subscriptions,
-- ops.client_logs, ops.log_review_cursor, sync.outbox, sync.idempotency_keys)
-- intentionally do NOT have RLS; the API enforces user_id = ctx.userId.
-- domain.projector_cursors is a singleton-per-worker (keyed by name),
-- with no org dimension — RLS would mean nothing here.
