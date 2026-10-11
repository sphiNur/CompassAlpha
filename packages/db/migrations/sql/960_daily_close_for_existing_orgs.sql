-- Daily close became a part of the product an organisation switches on
-- (auth.organizations.feature_flags -> 'dailyClose'); a new organisation
-- starts without it.
--
-- An organisation that has already recorded a daily close keeps it. Runs
-- on every migrate and only ever touches an organisation whose flags do
-- not mention dailyClose at all, so a later deliberate "off" is left alone.
SELECT set_config('app.system_context', 'maintenance', true);

UPDATE auth.organizations o
SET feature_flags = jsonb_set(coalesce(o.feature_flags, '{}'::jsonb), '{dailyClose}', 'true'::jsonb)
WHERE NOT (coalesce(o.feature_flags, '{}'::jsonb) ? 'dailyClose')
  AND EXISTS (
    SELECT 1 FROM inventory.store_daily_settlements s WHERE s.org_id = o.id
  );
