-- 0064_attendance_liveness.sql
--
-- Liveness and borrowed phones (owner request 2026-11-06).
--
-- * Liveness: with a store's liveness check on, a punch carries the face
--   photo plus two head-turn frames in a random order the server set. The
--   server checks the turns and a real-face model on every frame. A
--   failure is recorded on the punch and the managers are told.
-- * Borrowed phone: someone without their own phone clocks on a
--   colleague's (same store). The punch is the owner's own face, matched
--   and live; `via_member_id` names whose phone it was.
-- * New phone: a face-checked punch from a phone other than the bound one
--   goes through, marked `new_device`, instead of being refused.

SELECT set_config('app.system_context', 'maintenance', true);
--> statement-breakpoint
ALTER TABLE inventory.attendance_store_policies
  ADD COLUMN IF NOT EXISTS require_liveness boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- No foreign key on via_member_id: punches are never updated (ap_guard),
-- so ON DELETE SET NULL would fail; created_by_member_id is the same.
ALTER TABLE inventory.attendance_punches
  ADD COLUMN IF NOT EXISTS liveness varchar(10)
    CHECK (liveness IS NULL OR liveness IN ('pass', 'fail', 'unchecked')),
  ADD COLUMN IF NOT EXISTS liveness_score real,
  ADD COLUMN IF NOT EXISTS liveness_nonce varchar(64),
  ADD COLUMN IF NOT EXISTS via_member_id uuid,
  ADD COLUMN IF NOT EXISTS new_device boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- A challenge is good for one punch.
CREATE UNIQUE INDEX IF NOT EXISTS ap_liveness_nonce_key
  ON inventory.attendance_punches (liveness_nonce) WHERE liveness_nonce IS NOT NULL;
--> statement-breakpoint
ALTER TABLE inventory.attendance_photos DROP CONSTRAINT IF EXISTS attendance_photos_kind_check;
--> statement-breakpoint
ALTER TABLE inventory.attendance_photos
  ADD CONSTRAINT attendance_photos_kind_check CHECK (kind IN ('face', 'scene', 'left', 'right'));
