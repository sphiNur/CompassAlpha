-- Server-side purchase-history pagination/filtering (2026-08-05).
-- The partial run index supports both newest-first and reverse scans; the
-- session index makes store visibility/filter EXISTS checks cheap without
-- excluding inactive/soft-deleted stores that still own historical rows.

CREATE INDEX IF NOT EXISTS mrv_history_page_idx
  ON read_model.market_runs_v
    (org_id, run_date DESC, run_index DESC, id DESC)
  WHERE status = 'finished';

CREATE INDEX IF NOT EXISTS osv_history_store_idx
  ON read_model.order_sessions_v (org_id, store_id, run_id)
  WHERE run_id IS NOT NULL;
