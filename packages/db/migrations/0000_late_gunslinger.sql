CREATE TABLE IF NOT EXISTS "auth"."member_role_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"scope_type" varchar(16) DEFAULT 'global' NOT NULL,
	"scope_id" uuid,
	"granted_by" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth"."members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"invited_by" uuid,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth"."organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name" varchar(200) NOT NULL,
	"plan" varchar(32) DEFAULT 'free' NOT NULL,
	"locale_default" varchar(16) DEFAULT 'en' NOT NULL,
	"timezone" varchar(64) DEFAULT 'UTC' NOT NULL,
	"workflow" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"feature_flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth"."permissions" (
	"key" varchar(100) PRIMARY KEY NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth"."policy_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"description" text,
	"subject_expr" text NOT NULL,
	"action" varchar(100) NOT NULL,
	"resource_expr" text NOT NULL,
	"effect" varchar(8) NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth"."refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"family" uuid NOT NULL,
	"parent_id" uuid,
	"user_agent" text,
	"ip" varchar(64),
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth"."role_permissions" (
	"role_id" uuid NOT NULL,
	"permission_key" varchar(100) NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_key_pk" PRIMARY KEY("role_id","permission_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth"."roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"is_built_in" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tg_user_id" bigint,
	"tg_username" varchar(64),
	"email" varchar(200),
	"display_name" varchar(200) NOT NULL,
	"avatar_url" text,
	"locale" varchar(16),
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory"."categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"slug" varchar(64) NOT NULL,
	"names" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sort_index" integer DEFAULT 0 NOT NULL,
	"icon" varchar(64),
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory"."price_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"supplier_id" uuid,
	"store_id" uuid,
	"run_id" uuid,
	"unit_price" numeric(14, 2) NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory"."sku_supplier_links" (
	"sku_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"default_price" numeric(14, 2),
	"last_seen_price" numeric(14, 2),
	"last_seen_at" timestamp with time zone,
	"is_preferred" boolean DEFAULT false NOT NULL,
	CONSTRAINT "sku_supplier_links_sku_id_supplier_id_pk" PRIMARY KEY("sku_id","supplier_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory"."skus" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"category_id" uuid,
	"code" varchar(64),
	"names" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"unit" varchar(16) NOT NULL,
	"step" numeric(10, 3) DEFAULT '1' NOT NULL,
	"image_url" text,
	"suggested_qty" numeric(12, 3),
	"sort_index" integer DEFAULT 0 NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory"."store_supplier_prefs" (
	"store_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"rank" integer DEFAULT 100 NOT NULL,
	CONSTRAINT "store_supplier_prefs_store_id_supplier_id_pk" PRIMARY KEY("store_id","supplier_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory"."stores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"code" varchar(32),
	"address" text,
	"geo_lat" numeric(9, 6),
	"geo_lng" numeric(9, 6),
	"timezone" varchar(64),
	"sort_index" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventory"."suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"contact_phone" varchar(32),
	"contact_tg" varchar(64),
	"address" text,
	"photo_url" text,
	"rating" numeric(3, 2),
	"reliability_score" numeric(5, 2) DEFAULT '100.00',
	"price_trust_score" numeric(5, 2) DEFAULT '100.00',
	"notes" text,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "domain"."events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"stream_type" varchar(32) NOT NULL,
	"stream_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"type" varchar(64) NOT NULL,
	"payload" jsonb NOT NULL,
	"actor_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"correlation_id" uuid,
	"causation_id" uuid,
	"idempotency_key" varchar(128)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "domain"."policy_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"actor_id" uuid,
	"action" varchar(100) NOT NULL,
	"resource_type" varchar(64),
	"resource_id" uuid,
	"decision" varchar(16) NOT NULL,
	"reason" text,
	"matched_rules" jsonb DEFAULT '[]'::jsonb,
	"inputs" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "domain"."projector_cursors" (
	"name" varchar(64) PRIMARY KEY NOT NULL,
	"last_event_id" uuid,
	"last_event_occurred_at" timestamp with time zone,
	"lag" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "domain"."snapshots" (
	"stream_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"state" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "read_model"."market_runs_v" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"run_date" date NOT NULL,
	"run_index" integer DEFAULT 0 NOT NULL,
	"status" varchar(24) NOT NULL,
	"planned_total" numeric(14, 2),
	"actual_total" numeric(14, 2),
	"purchaser_member_id" uuid,
	"session_ids_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "read_model"."order_items_v" (
	"session_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"qty" numeric(12, 3) DEFAULT '0' NOT NULL,
	"note" text,
	"last_edited_by_user_id" uuid,
	"last_edited_at" timestamp with time zone,
	CONSTRAINT "order_items_v_session_id_sku_id_pk" PRIMARY KEY("session_id","sku_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "read_model"."order_sessions_v" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"order_date" date NOT NULL,
	"status" varchar(24) NOT NULL,
	"claimed_by_member_id" uuid,
	"claimed_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by_member_id" uuid,
	"reject_reason" text,
	"run_id" uuid,
	"totals_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "read_model"."run_item_stores_v" (
	"run_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"delivered_at" timestamp with time zone,
	"delivered_by_user_id" uuid,
	"confirmed_at" timestamp with time zone,
	"confirmed_by_user_id" uuid,
	"confirm_status" varchar(16),
	"confirm_note" text,
	"confirm_photo_url" text,
	CONSTRAINT "run_item_stores_v_run_id_sku_id_store_id_pk" PRIMARY KEY("run_id","sku_id","store_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "read_model"."run_items_v" (
	"run_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"planned_qty" numeric(12, 3) NOT NULL,
	"purchased_qty" numeric(12, 3),
	"supplier_id" uuid,
	"unit_price" numeric(14, 2),
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"unavailable_note" text,
	"receipt_photo_url" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_items_v_run_id_sku_id_pk" PRIMARY KEY("run_id","sku_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ops"."audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"actor_id" uuid,
	"action" varchar(100) NOT NULL,
	"resource_type" varchar(64),
	"resource_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"ip" varchar(64),
	"user_agent" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ops"."client_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"user_id" uuid,
	"session_id" varchar(64) NOT NULL,
	"level" varchar(8) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"action" varchar(64),
	"target" varchar(200),
	"data" jsonb,
	"error_msg" text,
	"error_stack" text,
	"platform" varchar(32),
	"app_version" varchar(32),
	"trace_id" varchar(64),
	"span_id" varchar(32),
	"client_ts" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ops"."daily_metrics" (
	"org_id" uuid NOT NULL,
	"metric_date" varchar(10) NOT NULL,
	"metric" varchar(64) NOT NULL,
	"value" integer DEFAULT 0 NOT NULL,
	"breakdown" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ops"."feature_flags" (
	"org_id" uuid NOT NULL,
	"key" varchar(100) NOT NULL,
	"value" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ops"."log_review_cursor" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"last_reviewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ops"."notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"channel" varchar(16) NOT NULL,
	"template" varchar(64) NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deep_link" text,
	"sent_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"dedup_key" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ops"."web_push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync"."idempotency_keys" (
	"key" varchar(128) PRIMARY KEY NOT NULL,
	"route" varchar(100) NOT NULL,
	"user_id" uuid,
	"response" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync"."outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregate" varchar(32) NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"channel" varchar(32) NOT NULL,
	"payload" jsonb NOT NULL,
	"retries" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth"."member_role_bindings" ADD CONSTRAINT "member_role_bindings_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "auth"."members"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth"."member_role_bindings" ADD CONSTRAINT "member_role_bindings_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "auth"."roles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth"."member_role_bindings" ADD CONSTRAINT "member_role_bindings_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "auth"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth"."members" ADD CONSTRAINT "members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth"."members" ADD CONSTRAINT "members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth"."members" ADD CONSTRAINT "members_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "auth"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth"."policy_rules" ADD CONSTRAINT "policy_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth"."role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "auth"."roles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth"."role_permissions" ADD CONSTRAINT "role_permissions_permission_key_permissions_key_fk" FOREIGN KEY ("permission_key") REFERENCES "auth"."permissions"("key") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth"."roles" ADD CONSTRAINT "roles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory"."categories" ADD CONSTRAINT "categories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory"."price_history" ADD CONSTRAINT "price_history_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory"."price_history" ADD CONSTRAINT "price_history_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "inventory"."skus"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory"."price_history" ADD CONSTRAINT "price_history_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "inventory"."suppliers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory"."price_history" ADD CONSTRAINT "price_history_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "inventory"."stores"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory"."sku_supplier_links" ADD CONSTRAINT "sku_supplier_links_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "inventory"."skus"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory"."sku_supplier_links" ADD CONSTRAINT "sku_supplier_links_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "inventory"."suppliers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory"."skus" ADD CONSTRAINT "skus_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory"."skus" ADD CONSTRAINT "skus_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "inventory"."categories"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory"."store_supplier_prefs" ADD CONSTRAINT "store_supplier_prefs_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "inventory"."stores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory"."store_supplier_prefs" ADD CONSTRAINT "store_supplier_prefs_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "inventory"."suppliers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory"."stores" ADD CONSTRAINT "stores_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory"."suppliers" ADD CONSTRAINT "suppliers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "domain"."events" ADD CONSTRAINT "events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "domain"."events" ADD CONSTRAINT "events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_model"."market_runs_v" ADD CONSTRAINT "market_runs_v_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_model"."order_items_v" ADD CONSTRAINT "order_items_v_session_id_order_sessions_v_id_fk" FOREIGN KEY ("session_id") REFERENCES "read_model"."order_sessions_v"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_model"."order_items_v" ADD CONSTRAINT "order_items_v_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "inventory"."skus"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_model"."order_items_v" ADD CONSTRAINT "order_items_v_last_edited_by_user_id_users_id_fk" FOREIGN KEY ("last_edited_by_user_id") REFERENCES "auth"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_model"."order_sessions_v" ADD CONSTRAINT "order_sessions_v_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_model"."order_sessions_v" ADD CONSTRAINT "order_sessions_v_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "inventory"."stores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_model"."run_item_stores_v" ADD CONSTRAINT "run_item_stores_v_run_id_market_runs_v_id_fk" FOREIGN KEY ("run_id") REFERENCES "read_model"."market_runs_v"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_model"."run_item_stores_v" ADD CONSTRAINT "run_item_stores_v_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "inventory"."skus"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_model"."run_item_stores_v" ADD CONSTRAINT "run_item_stores_v_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "inventory"."stores"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_model"."run_item_stores_v" ADD CONSTRAINT "run_item_stores_v_delivered_by_user_id_users_id_fk" FOREIGN KEY ("delivered_by_user_id") REFERENCES "auth"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_model"."run_item_stores_v" ADD CONSTRAINT "run_item_stores_v_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "auth"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_model"."run_items_v" ADD CONSTRAINT "run_items_v_run_id_market_runs_v_id_fk" FOREIGN KEY ("run_id") REFERENCES "read_model"."market_runs_v"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_model"."run_items_v" ADD CONSTRAINT "run_items_v_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "inventory"."skus"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "read_model"."run_items_v" ADD CONSTRAINT "run_items_v_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "inventory"."suppliers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ops"."audit_log" ADD CONSTRAINT "audit_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ops"."audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "auth"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ops"."feature_flags" ADD CONSTRAINT "feature_flags_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ops"."notifications" ADD CONSTRAINT "notifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ops"."notifications" ADD CONSTRAINT "notifications_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ops"."web_push_subscriptions" ADD CONSTRAINT "web_push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mrb_member_idx" ON "auth"."member_role_bindings" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mrb_role_idx" ON "auth"."member_role_bindings" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "members_org_user_unique" ON "auth"."members" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "members_org_idx" ON "auth"."members" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_slug_unique" ON "auth"."organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "policy_org_action_idx" ON "auth"."policy_rules" USING btree ("org_id","action");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "refresh_token_hash_unique" ON "auth"."refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refresh_token_family_idx" ON "auth"."refresh_tokens" USING btree ("family");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "refresh_token_user_idx" ON "auth"."refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "roles_org_slug_unique" ON "auth"."roles" USING btree ("org_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_tg_user_id_unique" ON "auth"."users" USING btree ("tg_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique" ON "auth"."users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "categories_org_slug_unique" ON "inventory"."categories" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_hist_sku_idx" ON "inventory"."price_history" USING btree ("sku_id","observed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_hist_org_idx" ON "inventory"."price_history" USING btree ("org_id","observed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_hist_supplier_idx" ON "inventory"."price_history" USING btree ("supplier_id","observed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ssl_supplier_idx" ON "inventory"."sku_supplier_links" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skus_org_idx" ON "inventory"."skus" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skus_org_category_idx" ON "inventory"."skus" USING btree ("org_id","category_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skus_org_code_unique" ON "inventory"."skus" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ssp_rank_idx" ON "inventory"."store_supplier_prefs" USING btree ("store_id","rank");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stores_org_idx" ON "inventory"."stores" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stores_org_code_unique" ON "inventory"."stores" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "suppliers_org_idx" ON "inventory"."suppliers" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "suppliers_org_name_idx" ON "inventory"."suppliers" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "events_stream_seq_unique" ON "domain"."events" USING btree ("stream_id","seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_stream_type_idx" ON "domain"."events" USING btree ("stream_type","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_correlation_idx" ON "domain"."events" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_org_idx" ON "domain"."events" USING btree ("org_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_type_occurred_idx" ON "domain"."events" USING btree ("type","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "policy_dec_actor_idx" ON "domain"."policy_decisions" USING btree ("actor_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "policy_dec_action_idx" ON "domain"."policy_decisions" USING btree ("action","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "snapshots_stream_pk" ON "domain"."snapshots" USING btree ("stream_id","seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "snapshots_stream_idx" ON "domain"."snapshots" USING btree ("stream_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mrv_org_date_index_unique" ON "read_model"."market_runs_v" USING btree ("org_id","run_date","run_index");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mrv_org_status_idx" ON "read_model"."market_runs_v" USING btree ("org_id","status","run_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oiv_sku_idx" ON "read_model"."order_items_v" USING btree ("sku_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "osv_org_store_member_date_idx" ON "read_model"."order_sessions_v" USING btree ("org_id","store_id","member_id","order_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "osv_org_status_date_idx" ON "read_model"."order_sessions_v" USING btree ("org_id","status","order_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "osv_run_idx" ON "read_model"."order_sessions_v" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "risv_store_idx" ON "read_model"."run_item_stores_v" USING btree ("store_id","delivered_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "riv_status_idx" ON "read_model"."run_items_v" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_org_idx" ON "ops"."audit_log" USING btree ("org_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_actor_idx" ON "ops"."audit_log" USING btree ("actor_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clog_user_idx" ON "ops"."client_logs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clog_session_idx" ON "ops"."client_logs" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clog_created_idx" ON "ops"."client_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clog_org_created_idx" ON "ops"."client_logs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "daily_metrics_pk" ON "ops"."daily_metrics" USING btree ("org_id","metric_date","metric");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "flags_org_key_pk" ON "ops"."feature_flags" USING btree ("org_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notif_recipient_idx" ON "ops"."notifications" USING btree ("recipient_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notif_dedup_unique" ON "ops"."notifications" USING btree ("dedup_key") WHERE dedup_key IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "webpush_endpoint_unique" ON "ops"."web_push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webpush_user_idx" ON "ops"."web_push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idem_expires_idx" ON "sync"."idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idem_user_route_unique" ON "sync"."idempotency_keys" USING btree ("user_id","route","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbox_pending_idx" ON "sync"."outbox" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbox_event_idx" ON "sync"."outbox" USING btree ("event_id");