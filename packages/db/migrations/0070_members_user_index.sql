-- 0070_members_user_index.sql
--
-- Review NEW-MEMBERS-USER-INDEX (2026-11-12). auth.members had no index
-- that starts with user_id, only the primary key, the (org_id, user_id)
-- unique index and the org_id index. Sign-in, token refresh, the list of
-- a user's workspaces and the choice of workspace at sign-in all find
-- members by user_id. Each of those lookups read the whole
-- members_org_user_unique index, where user_id is the second column.
--
-- The table is small, so a plain CREATE INDEX holds its write lock for
-- only a moment.

CREATE INDEX IF NOT EXISTS members_user_idx ON auth.members (user_id);
