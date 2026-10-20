-- Existing organisations were created before subscription rows existed.
-- The application role is deliberately not BYPASSRLS, so this backfill
-- must explicitly declare a system context.
SELECT set_config('app.system_context', 'maintenance', true);
--> statement-breakpoint
INSERT INTO "auth"."billing_plans" ("code", "name", "description", "limits", "sort_index") VALUES
	('legacy', 'Legacy / Enterprise', 'Unlimited agreement created before subscription enforcement', '{"stores":null,"members":null}'::jsonb, 999),
	('starter', 'Starter', 'One store and a small team', '{"stores":1,"members":10}'::jsonb, 10),
	('growth', 'Growth', 'Up to three stores', '{"stores":3,"members":30}'::jsonb, 20),
	('pro', 'Professional', 'Expanded stores and team limits', '{"stores":10,"members":100}'::jsonb, 30)
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
INSERT INTO "auth"."organization_subscriptions" ("org_id", "plan_code", "status", "note")
SELECT "id", 'legacy', 'active', 'Backfilled when subscription enforcement launched'
FROM "auth"."organizations"
ON CONFLICT ("org_id") DO NOTHING;--> statement-breakpoint
UPDATE "auth"."organizations"
SET "plan" = 'legacy'
WHERE "id" IN (
	SELECT "org_id" FROM "auth"."organization_subscriptions" WHERE "plan_code" = 'legacy'
);
