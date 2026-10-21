-- 0048_backfill_builtin_role_permissions.sql
--
-- (2026-10-21 audit CA-10 / CA-57) Remove the need for the
-- `|| users.manage` fallback in sales.record / inventory.adjust checks.
--
-- Deploys run `migrate`, not `seed`, so organisations created before these
-- grants were added to the built-in roles in seed-data.ts never received
-- them: manager → sales.record + inventory.adjust (486c653 / 10ed9b7,
-- 2026-05-13) and staff → sales.record (fdee454, 2026-08-05). No earlier
-- migration granted them (0021 only registered the keys; 0037 only
-- touched cashier/settlement). The API papered over the manager gap by
-- also accepting `users.manage`, which made a store-level deny of
-- sales.record / inventory.adjust a no-op for managers.
--
-- Deliberately NARROW: only these three (slug, permission) pairs, only on
-- built-in roles. A blanket "re-apply every seed grant" would silently undo
-- permissions an org admin removed from a built-in role on purpose
-- (admin.roleUpdate allows that and role_permissions keeps no history).
-- For managers this changes nothing effective — the users.manage fallback
-- already let them do both.
--
-- SAFETY: idempotent (ON CONFLICT DO NOTHING); never removes anything.
-- role_permissions is under FORCE RLS, so the system context is declared
-- first (same as 0044–0046).
SELECT set_config('app.system_context', 'maintenance', true);
--> statement-breakpoint
INSERT INTO auth.permissions (key, description) VALUES
	('inventory.adjust', 'Stocktake / wastage corrections'),
	('sales.record', 'Record dish sales at a store')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
INSERT INTO auth.role_permissions (role_id, permission_key)
SELECT r.id, g.permission_key
FROM auth.roles r
JOIN (VALUES
	('manager', 'sales.record'),
	('manager', 'inventory.adjust'),
	('staff', 'sales.record')
) AS g(slug, permission_key) ON g.slug = r.slug
WHERE r.is_built_in = true
ON CONFLICT DO NOTHING;
