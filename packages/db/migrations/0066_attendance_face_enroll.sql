-- 0066_attendance_face_enroll.sql
--
-- Face-only clocking (owner decisions 2026-11-06):
--
-- * Every punch someone makes themselves is checked by face, in every store
--   (the store switches for photo / face / liveness no longer apply).
-- * A face is registered through its own guided enrollment: several
--   photos (straight on twice, each side, up, down), each checked for
--   quality and liveness, then approved by a store manager before the
--   person can clock.
-- * The reference faces taken from people's first punches are dropped:
--   everyone enrolls again.

SELECT set_config('app.system_context', 'maintenance', true);
--> statement-breakpoint
DROP TABLE IF EXISTS inventory.attendance_face_refs;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS inventory.attendance_face_enrollments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES auth.organizations(id) ON DELETE CASCADE,
  member_id             uuid NOT NULL REFERENCES auth.members(id) ON DELETE CASCADE,
  -- The store the person enrolled from: its managers are asked to approve.
  store_id              uuid NOT NULL REFERENCES inventory.stores(id) ON DELETE CASCADE,
  status                varchar(10) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  decided_by_member_id  uuid,
  decided_at            timestamptz,
  note                  varchar(300)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS afe_org_idx ON inventory.attendance_face_enrollments (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS afe_member_idx ON inventory.attendance_face_enrollments (member_id);
--> statement-breakpoint
-- At most one waiting and one in use per person.
CREATE UNIQUE INDEX IF NOT EXISTS afe_one_pending
  ON inventory.attendance_face_enrollments (member_id) WHERE status = 'pending';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS afe_one_approved
  ON inventory.attendance_face_enrollments (member_id) WHERE status = 'approved';
--> statement-breakpoint
-- The enrollment's photos and their SFace features. Dropped when it is
-- rejected or replaced.
CREATE TABLE IF NOT EXISTS inventory.attendance_face_samples (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES auth.organizations(id) ON DELETE CASCADE,
  enrollment_id  uuid NOT NULL REFERENCES inventory.attendance_face_enrollments(id) ON DELETE CASCADE,
  pose           varchar(8) NOT NULL CHECK (pose IN ('front', 'front2', 'left', 'right', 'up', 'down')),
  feature        real[] NOT NULL CHECK (cardinality(feature) = 128),
  bytes          bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 600000),
  real_score     real,
  CONSTRAINT afs_enrollment_pose_key UNIQUE (enrollment_id, pose)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS afs_org_idx ON inventory.attendance_face_samples (org_id);
