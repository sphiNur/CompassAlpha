-- The development/default tenant is now the Eden workspace.
SELECT set_config('app.system_context', 'maintenance', true);
--> statement-breakpoint
UPDATE "auth"."organizations"
SET "name" = 'Eden', "updated_at" = now()
WHERE "slug" = 'default' AND "name" <> 'Eden';
