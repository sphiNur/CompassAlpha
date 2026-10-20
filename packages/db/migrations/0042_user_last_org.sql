ALTER TABLE "auth"."users" ADD COLUMN "last_org_id" uuid;--> statement-breakpoint
ALTER TABLE "auth"."users" ADD CONSTRAINT "users_last_org_id_organizations_id_fk" FOREIGN KEY ("last_org_id") REFERENCES "auth"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_last_org_idx" ON "auth"."users" USING btree ("last_org_id");
