-- 0032_expense_templates.sql
--
-- (M3.57, 2026-05-23) Org-level expense templates that auto-attach
-- to every new market run.
--
-- BACKGROUND
--   The procurement workflow has a long tail of recurring off-catalog
--   expenses: porter/装卸费, taxi/的士, parking, etc. Before this
--   change the purchaser had to manually re-add each one on every
--   run via the "+ Add" sheet — many keystrokes, missed entries,
--   inconsistent labeling across runs.
--
--   User-requested fix: an org-wide list of "standard expenses".
--   Manager defines them once in Admin; every run.create that follows
--   auto-emits RunExpenseAdded for each non-archived template, with
--   the template's default qty + unitPrice, payment method, and an
--   even-split across the run's stores. The purchaser sees them as
--   normal expense rows on the run page — can remove or edit if a
--   particular run doesn't incur them.
--
-- SHAPE
--   id, org_id          — standard org-scoped identity.
--   label, unit_hint    — copied verbatim onto each auto-attached
--                          expense row.
--   default_qty         — usually 1 ("1 trip", "1 pickup"). Can be
--                          fractional for unusual unit semantics.
--   default_unit_price  — applied as the expense's unit_price at
--                          attach time. Mandatory > 0 (the auto-
--                          attached expense must pass the same
--                          PositiveDecimalString check the AddExpense
--                          command uses). Purchaser can remove + re-
--                          add at run time if the actual amount
--                          differs.
--   default_payment_method
--                       — 'cash' (default) | 'transfer'.
--   sort_index          — render order in admin UI + the auto-attach
--                          sequence (controls expenses[] order on
--                          the new run).
--   is_archived         — soft-delete; archived templates skip the
--                          auto-attach loop. We keep the row so old
--                          runs that reference the label still read
--                          back cleanly.
--
-- RLS
--   Mirrors inventory.skus — org_isolation policy enforces tenant
--   boundary. Read by run.create (auto-attach loop) + admin UI
--   (CRUD). Write only by org.admin role (enforced at the tRPC
--   layer, not in SQL).
--
-- SAFETY
--   IF NOT EXISTS for re-run idempotency.

BEGIN;

CREATE TABLE IF NOT EXISTS inventory.expense_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES auth.organizations(id) ON DELETE CASCADE,
  label varchar(200) NOT NULL,
  unit_hint varchar(32),
  default_qty numeric(12, 3) NOT NULL DEFAULT '1',
  default_unit_price numeric(14, 2) NOT NULL,
  default_payment_method varchar(16) NOT NULL DEFAULT 'cash'
    CHECK (default_payment_method IN ('cash', 'transfer')),
  sort_index integer NOT NULL DEFAULT 0,
  is_archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Sort-order index: admin UI lists active templates by sort_index
-- ASC, then created_at ASC for stable order on ties. The auto-attach
-- loop reads the same order so expenses[] on the new run mirrors
-- what the admin sees.
CREATE INDEX IF NOT EXISTS expense_templates_org_active_idx
  ON inventory.expense_templates (org_id, sort_index, created_at)
  WHERE is_archived = false;

-- RLS — same shape as the rest of inventory.*. Hooked into the
-- per-org policy applied by sql/900_rls_policies.sql, but we ENABLE
-- + create the policy here so this migration is self-contained
-- (the post-migration policy script idempotently re-applies the
-- same policy without disturbing it).
ALTER TABLE inventory.expense_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON inventory.expense_templates;
CREATE POLICY org_isolation ON inventory.expense_templates
  USING (org_id = app_current_org() OR app_current_org() IS NULL);

COMMIT;
