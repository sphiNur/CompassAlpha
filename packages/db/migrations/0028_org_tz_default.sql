-- 0028_org_tz_default.sql
--
-- (D.1, M3.39, 2026-05-20) Switch the organizations.timezone DEFAULT
-- from 'UTC' to 'Asia/Tashkent', and backfill any existing UTC-defaulted
-- rows to match. The UZ launch tenant has been silently treating
-- UTC midnight as the day boundary, which is 5am Tashkent local —
-- orders placed early-morning landed on the wrong "today" key.
--
-- BACKGROUND
--   M1.17 added the timezone column with default 'UTC' but never wired
--   it through `todayInOrgTz()` (apps/api/src/trpc/routers/order.ts:48)
--   or `todayStr()` (run.ts:53). That stub commit said "M1 will fix",
--   never happened. Mid-May audit (Gemini + self) flagged this as a
--   P0 correctness bug for the UZ launch.
--
-- DATA CHANGE
--   UPDATE every row whose timezone is the stale default. This is
--   conservative: if a future tenant explicitly sets 'UTC' or any
--   other zone via admin UI, they're untouched. Only rows still on
--   the original-and-wrong default are migrated.
--
--   If you onboard a non-UZ tenant later, set their timezone via:
--     UPDATE auth.organizations SET timezone = 'Europe/Moscow'
--      WHERE slug = 'newtenant';
--
-- SAFETY
--   Idempotent — re-running the UPDATE on rows already at
--   'Asia/Tashkent' is a no-op. ALTER … SET DEFAULT is idempotent.

BEGIN;

ALTER TABLE auth.organizations
  ALTER COLUMN timezone SET DEFAULT 'Asia/Tashkent';

UPDATE auth.organizations
   SET timezone = 'Asia/Tashkent'
 WHERE timezone = 'UTC';

COMMIT;
