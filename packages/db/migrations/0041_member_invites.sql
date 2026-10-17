CREATE TABLE "auth"."member_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"invited_by" uuid,
	"token_hash" varchar(64) NOT NULL,
	"store_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"grants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" uuid,
	"accepted_by_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth"."member_invites" ADD CONSTRAINT "member_invites_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "auth"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."member_invites" ADD CONSTRAINT "member_invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."member_invites" ADD CONSTRAINT "member_invites_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."member_invites" ADD CONSTRAINT "member_invites_accepted_by_member_id_members_id_fk" FOREIGN KEY ("accepted_by_member_id") REFERENCES "auth"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "member_invites_token_hash_unique" ON "auth"."member_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "member_invites_org_idx" ON "auth"."member_invites" USING btree ("org_id");
