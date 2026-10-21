-- 0050_member_invite_revocation.sql
--
-- (2026-10-21) CA-19 / A-06 — invite links can be listed and revoked.
--
-- A shareable invite link used to stay valid for up to 30 days with no
-- way to withdraw it: a link forwarded to the wrong chat could only be
-- waited out. admin.memberInviteRevoke now stamps revoked_at / revoked_by
-- and auth.acceptInvite refuses a revoked invite. Both columns are
-- nullable and default NULL, so every existing invite stays exactly as
-- valid (or used / expired) as it was.

ALTER TABLE "auth"."member_invites" ADD COLUMN "revoked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "auth"."member_invites" ADD COLUMN "revoked_by" uuid;
--> statement-breakpoint
ALTER TABLE "auth"."member_invites" ADD CONSTRAINT "member_invites_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;
