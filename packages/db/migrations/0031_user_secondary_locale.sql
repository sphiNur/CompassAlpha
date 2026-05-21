-- 0031_user_secondary_locale.sql
--
-- (M3.45, 2026-05-22) Per-user "secondary display language" for the
-- bilingual product-name workflow: operator reads in their primary
-- locale, but copies the per-vendor purchase list in the secondary
-- locale (so vendors at the market who only know Uzbek can read it).
--
-- NULL = no secondary, single-language UI (default behavior, the
-- M3.45 change is invisible until opted in).
--
-- Lives on `users` (not `members`) because it's a personal display
-- preference that follows the human across orgs — same rationale as
-- the existing `locale` column.

BEGIN;

ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS secondary_locale varchar(16);

COMMIT;
