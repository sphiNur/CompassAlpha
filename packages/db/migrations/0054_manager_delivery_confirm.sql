-- 0054_manager_delivery_confirm.sql
--
-- DLV-13 (2026-10-30, owner decision): the built-in store manager could
-- not sign for a delivery at their own store (only staff held
-- delivery.confirm), so a store with no staff on shift could not receive.
-- seed-data.ts now grants it; deploys run `migrate`, not `seed`, so the
-- organisations that already exist get it here.
--
-- Deliberately narrow, like 0048: one (slug, permission) pair, built-in
-- roles only, ON CONFLICT DO NOTHING; never removes anything. An org
-- that later takes it away from its managers keeps that choice.
-- role_permissions is under FORCE RLS, so the system context comes first.
SELECT set_config('app.system_context', 'maintenance', true);
--> statement-breakpoint
INSERT INTO auth.permissions (key, description) VALUES
	('delivery.confirm', 'Confirm a delivery on store side')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
INSERT INTO auth.role_permissions (role_id, permission_key)
SELECT r.id, 'delivery.confirm'
FROM auth.roles r
WHERE r.slug = 'manager' AND r.is_built_in = true
ON CONFLICT DO NOTHING;
