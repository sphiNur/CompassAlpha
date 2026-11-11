-- Purchasing baseline, from the event log (read-only).
-- How long a purchase trip takes, how fast prices get entered, how often
-- an entry is corrected. Used to judge changes to the purchaser screen:
-- run before and after, per org. Times are wall clock between events, so
-- a gap includes walking between stalls — compare medians, not means.
-- Per-trip averages count trips only (started, then delivering), as
-- `trips` does: a run that never became one, or began before the window,
-- used to pull them down (review OPS-43, 2026-11-11).
--
--   psql "$DATABASE_URL" -v days=60 -f scripts/sql/purchase-metrics.sql
BEGIN READ ONLY;
SELECT set_config('app.system_context', 'maintenance', true);

WITH ev AS (
  SELECT e.org_id, e.stream_id AS run_id, e.type, e.occurred_at, e.actor_id, e.payload
  FROM domain.events e
  WHERE e.stream_type = 'run'
    AND e.occurred_at > now() - make_interval(days => :days)
),
entries AS (            -- one row per price/N-A entry, with the gap since the previous one
  SELECT *, occurred_at - lag(occurred_at) OVER (PARTITION BY run_id ORDER BY occurred_at) AS gap,
         payload->>'supplierId' IS DISTINCT FROM
           lag(payload->>'supplierId') OVER (PARTITION BY run_id ORDER BY occurred_at) AS stall_change
  FROM ev WHERE type IN ('ItemPurchased', 'ItemUnavailable')
),
runs AS (
  SELECT r.run_id, r.org_id,
    max(r.occurred_at) FILTER (WHERE r.type = 'PurchaseStarted') AS started,
    min(r.occurred_at) FILTER (WHERE r.type = 'DeliveryStarted') AS delivering,
    count(*) FILTER (WHERE r.type = 'ItemPurchased')   AS bought,
    count(*) FILTER (WHERE r.type = 'ItemUnavailable') AS unavailable,
    count(*) FILTER (WHERE r.type = 'PurchaseRevised') AS revised,
    count(*) FILTER (WHERE r.type IN ('PurchaseUndone', 'UnavailableUndone')) AS undone,
    count(*) FILTER (WHERE r.type = 'ItemPurchased' AND r.payload->>'paymentMethod' = 'transfer') AS transfer,
    count(*) FILTER (WHERE r.payload ? 'priceConfirmed') AS price_outliers,
    count(*) FILTER (WHERE r.type = 'PurchaserItemAdded') AS added_on_site,
    count(*) FILTER (WHERE r.type = 'RunExpenseAdded') AS expenses
  FROM ev r GROUP BY 1, 2
)
SELECT
  o.name AS org,
  count(*) FILTER (WHERE started IS NOT NULL AND delivering > started) AS trips,
  round(avg(bought + unavailable) FILTER (WHERE started IS NOT NULL AND delivering > started))
    AS entries_per_trip,
  to_char(percentile_cont(0.5) WITHIN GROUP (ORDER BY delivering - started)
          FILTER (WHERE delivering > started), 'HH24:MI') AS median_trip,
  (SELECT round(extract(epoch FROM percentile_cont(0.5) WITHIN GROUP (ORDER BY gap)))
     FROM entries x JOIN runs y USING (run_id)
    WHERE y.org_id = o.id AND gap < interval '30 min') AS median_s_between_entries,
  (SELECT round(extract(epoch FROM percentile_cont(0.5) WITHIN GROUP (ORDER BY gap)))
     FROM entries x JOIN runs y USING (run_id)
    WHERE y.org_id = o.id AND gap < interval '30 min' AND NOT stall_change) AS median_s_same_stall,
  round(100.0 * sum(revised + undone) / nullif(sum(bought + unavailable), 0), 1) AS pct_corrected,
  round(100.0 * sum(unavailable) / nullif(sum(bought + unavailable), 0), 1) AS pct_unavailable,
  round(100.0 * sum(transfer) / nullif(sum(bought), 0), 1) AS pct_transfer,
  sum(price_outliers) AS price_outliers,
  round(avg(added_on_site) FILTER (WHERE started IS NOT NULL AND delivering > started), 1)
    AS added_per_trip,
  round(avg(expenses) FILTER (WHERE started IS NOT NULL AND delivering > started), 1)
    AS expenses_per_trip
FROM runs JOIN auth.organizations o ON o.id = runs.org_id
GROUP BY o.id, o.name
ORDER BY trips DESC;
COMMIT;
