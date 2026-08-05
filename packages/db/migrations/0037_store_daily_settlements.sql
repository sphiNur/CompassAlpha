-- 0037_store_daily_settlements.sql
--
-- Per-store daily closing ledger. One row per (org, store, business date),
-- editable by store cashiers/managers through the settlement.record
-- permission. Every API write appends an update-protected revision in the same
-- transaction; the version column prevents silent concurrent overwrites.

CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid
$$ LANGUAGE SQL STABLE;

CREATE TABLE IF NOT EXISTS inventory.store_daily_settlements (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                     uuid NOT NULL REFERENCES auth.organizations(id) ON DELETE CASCADE,
  store_id                   uuid NOT NULL REFERENCES inventory.stores(id) ON DELETE CASCADE,
  settlement_date            date NOT NULL,
  online_revenue             numeric(14, 2) NOT NULL DEFAULT 0 CHECK (online_revenue >= 0),
  invoiced_cash_revenue      numeric(14, 2) NOT NULL DEFAULT 0 CHECK (invoiced_cash_revenue >= 0),
  operating_expenses         numeric(14, 2) NOT NULL DEFAULT 0 CHECK (operating_expenses >= 0),
  wages_paid                 numeric(14, 2) NOT NULL DEFAULT 0 CHECK (wages_paid >= 0),
  wages_accrued              numeric(14, 2) NOT NULL DEFAULT 0 CHECK (wages_accrued >= 0),
  next_purchase_reserve      numeric(14, 2) NOT NULL DEFAULT 0 CHECK (next_purchase_reserve >= 0),
  prior_purchase_adjustment  numeric(14, 2) NOT NULL DEFAULT 0,
  cash_on_hand               numeric(14, 2) NOT NULL DEFAULT 0 CHECK (cash_on_hand >= 0),
  note                       text CHECK (note IS NULL OR char_length(note) <= 1000),
  version                    integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by_member_id       uuid REFERENCES auth.members(id) ON DELETE SET NULL,
  updated_by_member_id       uuid REFERENCES auth.members(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sds_org_store_date_unique
  ON inventory.store_daily_settlements (org_id, store_id, settlement_date);
CREATE INDEX IF NOT EXISTS sds_org_date_idx
  ON inventory.store_daily_settlements (org_id, settlement_date DESC);
CREATE INDEX IF NOT EXISTS sds_store_date_idx
  ON inventory.store_daily_settlements (store_id, settlement_date DESC);

CREATE TABLE IF NOT EXISTS inventory.store_daily_settlement_revisions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id        uuid NOT NULL REFERENCES inventory.store_daily_settlements(id) ON DELETE CASCADE,
  org_id               uuid NOT NULL REFERENCES auth.organizations(id) ON DELETE CASCADE,
  store_id             uuid NOT NULL REFERENCES inventory.stores(id) ON DELETE CASCADE,
  settlement_date      date NOT NULL,
  version              integer NOT NULL CHECK (version > 0),
  snapshot             jsonb NOT NULL,
  changed_fields       jsonb NOT NULL DEFAULT '[]'::jsonb,
  correction_reason    text CHECK (correction_reason IS NULL OR char_length(correction_reason) <= 500),
  -- Deliberately not an FK: the audit actor id survives membership removal.
  actor_member_id      uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sdsr_settlement_version_unique
  ON inventory.store_daily_settlement_revisions (settlement_id, version);
CREATE INDEX IF NOT EXISTS sdsr_org_date_idx
  ON inventory.store_daily_settlement_revisions (org_id, settlement_date DESC);
CREATE INDEX IF NOT EXISTS sdsr_store_date_idx
  ON inventory.store_daily_settlement_revisions (store_id, settlement_date DESC);

CREATE OR REPLACE FUNCTION inventory.reject_settlement_revision_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'daily settlement revisions are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sdsr_reject_update ON inventory.store_daily_settlement_revisions;
DROP FUNCTION IF EXISTS inventory.reject_settlement_revision_update();
DROP TRIGGER IF EXISTS sdsr_reject_mutation ON inventory.store_daily_settlement_revisions;
CREATE TRIGGER sdsr_reject_mutation
  BEFORE UPDATE OR DELETE ON inventory.store_daily_settlement_revisions
  FOR EACH ROW EXECUTE FUNCTION inventory.reject_settlement_revision_mutation();

ALTER TABLE inventory.store_daily_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.store_daily_settlements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON inventory.store_daily_settlements;
CREATE POLICY org_isolation ON inventory.store_daily_settlements
  USING (org_id = app_current_org() OR app_current_org() IS NULL);

ALTER TABLE inventory.store_daily_settlement_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.store_daily_settlement_revisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON inventory.store_daily_settlement_revisions;
CREATE POLICY org_isolation ON inventory.store_daily_settlement_revisions
  USING (org_id = app_current_org() OR app_current_org() IS NULL);

INSERT INTO auth.permissions (key, description)
VALUES ('settlement.record', 'Record and review a store daily settlement')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;

-- Never reinterpret an existing custom role as a privileged built-in. A
-- collision needs an explicit administrator decision (rename the custom role)
-- rather than a migration that silently grants financial permissions.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM auth.roles
    WHERE slug = 'cashier' AND is_built_in = false
  ) THEN
    RAISE EXCEPTION
      'Cannot install built-in cashier role: a custom role already uses slug cashier';
  END IF;
END $$;

INSERT INTO auth.roles (org_id, slug, name, description, is_built_in, rank)
SELECT
  o.id,
  'cashier',
  'Cashier',
  'Records store sales and completes the daily settlement',
  true,
  30
FROM auth.organizations o
ON CONFLICT (org_id, slug) DO NOTHING;

-- General staff keep sales entry, while the financial close is reserved for
-- the dedicated cashier role and higher store roles.
DELETE FROM auth.role_permissions rp
USING auth.roles r
WHERE rp.role_id = r.id
  AND r.slug = 'staff'
  AND r.is_built_in = true
  AND rp.permission_key = 'settlement.record';

INSERT INTO auth.role_permissions (role_id, permission_key)
SELECT r.id, 'settlement.record'
FROM auth.roles r
WHERE r.slug IN ('super_admin', 'admin', 'manager', 'cashier')
  AND r.is_built_in = true
ON CONFLICT DO NOTHING;

INSERT INTO auth.role_permissions (role_id, permission_key)
SELECT r.id, p.key
FROM auth.roles r
JOIN auth.permissions p ON p.key IN ('sales.record', 'settlement.record')
WHERE r.slug = 'cashier'
  AND r.is_built_in = true
ON CONFLICT DO NOTHING;
