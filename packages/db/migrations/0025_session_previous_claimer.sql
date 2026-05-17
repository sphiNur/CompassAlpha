-- 0025_session_previous_claimer.sql
--
-- (M3.22, 2026-05-18) Track the previous claimer for force-released
-- order sessions so the approval banner can show "原认领 X → 现 Y"
-- when a stale claim was overridden (manually via the Take-over button)
-- or auto-released (by the worker timeout sweep, M3.20).
--
-- BACKGROUND
--   M3.19 added the Take-over button: any approver can release another
--   approver's claim. M3.20 added the worker timeout sweep. After
--   either intervention the next reviewer claims and approves — but
--   they had no on-screen signal that someone else used to sit on this
--   order. The audit log captured the override events, but the banner
--   didn't surface them.
--
-- SCHEMA CHANGE
--   Add `read_model.order_sessions_v.previous_claimer_member_id` (uuid,
--   nullable). The projector populates this on
--   `ClaimReleased{reason: 'override' | 'timeout'}` and clears it on
--   manual self-release / Approved / Rejected / Withdrawn / EjectedFromRun.
--   Cleared at run end so a re-submitted session starts fresh.
--
-- SAFETY
--   Idempotent — IF NOT EXISTS. Nullable + no default → no backfill.
--   Existing sessions stay NULL until the next override / timeout
--   release lands, which is the correct semantics.

BEGIN;

ALTER TABLE read_model.order_sessions_v
  ADD COLUMN IF NOT EXISTS previous_claimer_member_id uuid;

-- No FK constraint: members can be archived without losing audit
-- visibility. If the row is missing on join, the API resolves
-- displayName to NULL and the FE falls back to a generic label.

COMMIT;
