-- 0030_run_expenses.sql
--
-- (M3.44, 2026-05-22) Off-catalog expenses recorded by the purchaser
-- during a run. Distinct from run_items_v because:
--   - No SKU foreign key. Free-text `label` is the identity.
--   - No delivery/confirmation lifecycle. Expenses are recorded but
--     not "delivered" to stores in the dispatch sense.
--   - No price_history side effect. These are one-offs.
--   - Soft-delete: `removed_at` is set when the purchaser removes the
--     row pre-finish. The original RunExpenseAdded event stays in the
--     log for audit; admin reports can still see "X added Y, then
--     removed Z minutes later with reason='...'".
--
-- USAGE
--   The purchaser opens the "+ Add" sheet, switches to the
--   "Off-catalog / expense" tab, types a free-text label, picks store(s),
--   enters qty + unit price, picks payment method, types a reason
--   (required for audit), uploads a receipt photo (mandatory for
--   amounts > 200,000 UZS — server-side enforced in commands.ts).
--
-- SAFETY
--   IF NOT EXISTS for re-run idempotency.
--   Partial index `rev_active_idx` covers the FE's "give me this run's
--   active expenses" query without scanning soft-deleted rows.

BEGIN;

CREATE TABLE IF NOT EXISTS read_model.run_expenses_v (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES read_model.market_runs_v(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES auth.organizations(id) ON DELETE CASCADE,
  label varchar(200) NOT NULL,
  unit_hint varchar(32),
  qty numeric(12, 3) NOT NULL DEFAULT '1',
  unit_price numeric(14, 2) NOT NULL,
  store_splits_json jsonb NOT NULL,
  payment_method varchar(16) NOT NULL DEFAULT 'cash',
  receipt_photo_url text,
  reason varchar(500) NOT NULL,
  added_by_member_id uuid NOT NULL,
  added_at timestamptz NOT NULL,
  removed_at timestamptz,
  removed_by_member_id uuid,
  remove_reason varchar(500)
);

CREATE INDEX IF NOT EXISTS rev_run_idx
  ON read_model.run_expenses_v (run_id, added_at);

CREATE INDEX IF NOT EXISTS rev_active_idx
  ON read_model.run_expenses_v (run_id)
  WHERE removed_at IS NULL;

COMMIT;
