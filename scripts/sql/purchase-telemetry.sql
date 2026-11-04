-- Purchaser-screen telemetry summary (ops.client_logs, kept 30 days).
-- Written by apps/web/src/pages/runs/lib/purchaseTelemetry.ts. Pairs with
-- purchase-metrics.sql (the event log) for the before/after comparison.
--
--   psql "$DATABASE_URL" -v days=14 -f scripts/sql/purchase-telemetry.sql
BEGIN READ ONLY;
SELECT set_config('app.system_context', 'maintenance', true);

SELECT
  o.name AS org,
  count(*) FILTER (WHERE l.kind = 'purchase.entry') AS entries,
  round(100.0 * count(*) FILTER (WHERE l.kind = 'purchase.entry' AND l.action = 'collapsed')
        / nullif(count(*) FILTER (WHERE l.kind = 'purchase.entry'), 0), 1) AS pct_one_tap,
  round((percentile_cont(0.5) WITHIN GROUP (ORDER BY (l.data->>'msInEditor')::numeric)
        FILTER (WHERE l.kind = 'purchase.entry' AND l.action = 'editor'))::numeric / 1000, 1) AS median_s_in_editor,
  round((percentile_cont(0.9) WITHIN GROUP (ORDER BY (l.data->>'msInEditor')::numeric)
        FILTER (WHERE l.kind = 'purchase.entry' AND l.action = 'editor'))::numeric / 1000, 1) AS p90_s_in_editor,
  round(100.0 * count(*) FILTER (WHERE l.kind = 'purchase.entry' AND (l.data->>'priceChanged')::boolean)
        / nullif(count(*) FILTER (WHERE l.kind = 'purchase.entry'), 0), 1) AS pct_price_changed,
  round(100.0 * count(*) FILTER (WHERE l.kind = 'purchase.entry' AND (l.data->>'qtyChanged')::boolean)
        / nullif(count(*) FILTER (WHERE l.kind = 'purchase.entry'), 0), 1) AS pct_qty_changed,
  round(100.0 * count(*) FILTER (WHERE l.kind = 'purchase.entry' AND l.data->>'method' = 'transfer')
        / nullif(count(*) FILTER (WHERE l.kind = 'purchase.entry'), 0), 1) AS pct_transfer,
  round(100.0 * count(*) FILTER (WHERE l.kind = 'purchase.entry' AND (l.data->>'online')::boolean IS FALSE)
        / nullif(count(*) FILTER (WHERE l.kind = 'purchase.entry'), 0), 1) AS pct_offline,
  count(*) FILTER (WHERE l.kind = 'purchase.unavailable') AS unavailable,
  count(*) FILTER (WHERE l.kind = 'purchase.abandon') AS editor_abandoned
FROM ops.client_logs l
LEFT JOIN auth.organizations o ON o.id = l.org_id
WHERE l.kind LIKE 'purchase.%' AND l.created_at > now() - make_interval(days => :days)
GROUP BY o.name
ORDER BY entries DESC;

-- Field text scale (Android font-size setting), for the type-size decision.
SELECT round((data->>'textScale')::numeric, 2) AS text_scale, platform,
       count(DISTINCT user_id) AS users
FROM ops.client_logs
WHERE kind = 'app.boot' AND data ? 'textScale' AND created_at > now() - make_interval(days => :days)
GROUP BY 1, 2 ORDER BY 3 DESC;
COMMIT;
