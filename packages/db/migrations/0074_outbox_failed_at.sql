-- 0074_outbox_failed_at.sql
--
-- Plan 2.2 (2026-11-23): a bot message the worker could not deliver was
-- closed by setting `sent_at`, the same as one that was delivered. Given
-- up after its retries (a Telegram outage overnight, a rotated relay key),
-- refused by Telegram, or dropped while delivery was off: each looked
-- delivered, nothing counted them, and the hourly retention deleted them
-- with the delivered rows after 30 days.
--
-- A closed row still has `sent_at` (so a worker from before this release
-- never takes it again), and one closed without delivery also has
-- `failed_at` and `failure`, one of:
--   gave_up        retries exhausted (worth looking at)
--   refused        Telegram refused it: the user blocked the bot, a bad id
--   undeliverable  the payload or the recipient can never become a message
--   disabled       bot delivery is off on this server
-- The retention keeps failed rows 90 days instead of 30; system.health
-- reports how many were given up in the last 24 hours.
--
-- Nullable columns with no default: no table rewrite. The index holds the
-- failed rows only.

ALTER TABLE sync.outbox ADD COLUMN IF NOT EXISTS failed_at timestamp with time zone;
--> statement-breakpoint
ALTER TABLE sync.outbox ADD COLUMN IF NOT EXISTS failure varchar(32);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS outbox_failed_idx ON sync.outbox (failed_at) WHERE failed_at IS NOT NULL;
