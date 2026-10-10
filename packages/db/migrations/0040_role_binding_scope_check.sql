-- A role binding's scope is 'global' (whole org, no scope_id) or 'store'
-- (one store, scope_id = that store). Nothing enforced it: the column is
-- a free varchar, unlike member_permission_overrides which has had this
-- CHECK since 0008.
--
-- A binding with any other scope_type is worse than useless. The session
-- adds its role's permissions to the flat set that decides which tabs
-- appear, while every scoped check (global or per store) skips it — so
-- the member is shown a screen whose requests are all refused, with
-- nothing pointing at the cause.
--
-- NOT VALID: enforced for every insert and update from now on, without
-- failing this migration over a row that may already be there. Find any
-- such rows with
--   SELECT * FROM auth.member_role_bindings
--   WHERE scope_type NOT IN ('global','store')
--      OR (scope_type = 'global') <> (scope_id IS NULL);
-- fix them, then VALIDATE CONSTRAINT.

ALTER TABLE auth.member_role_bindings
  DROP CONSTRAINT IF EXISTS mrb_scope_check;

ALTER TABLE auth.member_role_bindings
  ADD CONSTRAINT mrb_scope_check
  CHECK (
    (scope_type = 'global' AND scope_id IS NULL)
    OR (scope_type = 'store' AND scope_id IS NOT NULL)
  ) NOT VALID;
