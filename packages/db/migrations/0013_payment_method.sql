-- 0013_payment_method.sql
--
-- (M1.14, 2026-05-08) Track payment method per recorded purchase.
--
-- Driver: a single market run regularly mixes cash purchases (e.g.
-- vegetables at the open-air stall) with bank-transfer purchases (e.g.
-- the meat supplier who only accepts wires). The original system
-- aggregated everything as one `actual_total`, which left accounting
-- unable to reconcile petty cash drawer vs. bank statement separately.
--
-- Two read-model changes:
--
--   (1) read_model.run_items_v.payment_method
--       NOT NULL with default 'cash'. Backfilling all existing rows as
--       'cash' is the correct legacy assumption — transfers weren't
--       tracked at all before this change, so any historical row that
--       represents a transfer is no worse off than it was yesterday
--       (the old data already lacked the distinction). Going forward,
--       PurchaseItem / PurchaseRevised events carry the explicit value.
--
--   (2) read_model.market_runs_v.actual_cash_total / actual_transfer_total
--       Both nullable so the column NULL marks "run not finished yet".
--       FinishRun fills both based on the per-item payment_method.
--       Existing finished runs see NULL here — the FE renders a fallback
--       ("legacy total: X, breakdown unknown") if the breakdown columns
--       are NULL but actual_total is present.
--
-- Reversibility: dropping the columns is the inverse. The domain events
-- still carry the field via `applyRun` defaulting to 'cash' on absence,
-- so re-projection will work either way.

ALTER TABLE read_model.run_items_v
  ADD COLUMN payment_method varchar(16) NOT NULL DEFAULT 'cash';

ALTER TABLE read_model.market_runs_v
  ADD COLUMN actual_cash_total numeric(14, 2),
  ADD COLUMN actual_transfer_total numeric(14, 2);
