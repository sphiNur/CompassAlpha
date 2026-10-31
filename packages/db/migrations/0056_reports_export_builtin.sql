-- 0056_reports_export_builtin.sql
--
-- D10 (2026-10-31, owner decision): copying finance as TSV now needs
-- `reports.export`; until now nothing checked it, so every finance reader
-- could export. The built-in roles that read reports (manager, plus admin
-- and super_admin, which seed-data.ts grants every key) keep exporting:
-- seed-data.ts now lists it for the manager, and deploys run `migrate`,
-- not `seed`, so the organisations that already exist get it here.
--
-- Same shape as 0048 / 0054: built-in roles only, only those that hold
-- reports.view today, ON CONFLICT DO NOTHING; never removes anything.
-- Custom roles (an "accountant" made by an org) are left to their owner.
-- role_permissions is under FORCE RLS, so the system context comes first.
SELECT set_config('app.system_context', 'maintenance', true);
--> statement-breakpoint
INSERT INTO auth.permissions (key, description) VALUES
	('reports.export', 'Export reports to Excel')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
INSERT INTO auth.role_permissions (role_id, permission_key)
SELECT r.id, 'reports.export'
FROM auth.roles r
WHERE r.is_built_in = true
  AND EXISTS (
    SELECT 1 FROM auth.role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_key = 'reports.view'
  )
ON CONFLICT DO NOTHING;
