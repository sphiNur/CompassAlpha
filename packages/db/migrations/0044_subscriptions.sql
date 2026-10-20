SELECT set_config('app.system_context', 'maintenance', true);
--> statement-breakpoint
CREATE TABLE "auth"."billing_plans" (
	"code" varchar(32) PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"price_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"currency" varchar(3) DEFAULT 'UZS' NOT NULL,
	"billing_interval" varchar(16) DEFAULT 'manual' NOT NULL,
	"limits" jsonb DEFAULT '{"stores":1,"members":10}'::jsonb NOT NULL,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_index" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."organization_subscriptions" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"plan_code" varchar(32) NOT NULL,
	"status" varchar(16) DEFAULT 'trialing' NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"grace_ends_at" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"note" text,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth"."organization_subscriptions" ADD CONSTRAINT "organization_subscriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."organization_subscriptions" ADD CONSTRAINT "organization_subscriptions_plan_code_billing_plans_code_fk" FOREIGN KEY ("plan_code") REFERENCES "auth"."billing_plans"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."organization_subscriptions" ADD CONSTRAINT "organization_subscriptions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "org_sub_plan_idx" ON "auth"."organization_subscriptions" USING btree ("plan_code");--> statement-breakpoint
CREATE INDEX "org_sub_status_idx" ON "auth"."organization_subscriptions" USING btree ("status");--> statement-breakpoint
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
