-- 0067_attendance_face_ring.sql
--
-- Face enrollment as a ring (owner request 2026-11-06, like Face ID): the
-- person turns their head in a slow circle and the phone keeps a photo in
-- each of eight directions, plus straight on at the start and the end.
-- The diagonal directions are new pose names, longer than 8 characters.

SELECT set_config('app.system_context', 'maintenance', true);
--> statement-breakpoint
ALTER TABLE inventory.attendance_face_samples
  DROP CONSTRAINT IF EXISTS attendance_face_samples_pose_check;
--> statement-breakpoint
ALTER TABLE inventory.attendance_face_samples ALTER COLUMN pose TYPE varchar(10);
--> statement-breakpoint
ALTER TABLE inventory.attendance_face_samples
  ADD CONSTRAINT attendance_face_samples_pose_check CHECK (pose IN (
    'front', 'front2', 'left', 'right', 'up', 'down',
    'upleft', 'upright', 'downleft', 'downright'
  ));
