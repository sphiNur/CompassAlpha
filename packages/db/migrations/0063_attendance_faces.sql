-- 0063_attendance_faces.sql
--
-- Face check on clock-in photos (owner request 2026-11-05; runs on our own
-- server). With a store's face check on, the face photo of each self punch
-- is matched against the person's reference face: the first face they
-- clock with, replaceable by a manager. A mismatch is recorded and the
-- managers are told; it does not stop the punch.

SELECT set_config('app.system_context', 'maintenance', true);
--> statement-breakpoint
ALTER TABLE inventory.attendance_store_policies
  ADD COLUMN IF NOT EXISTS require_face boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE inventory.attendance_photos
  ADD COLUMN IF NOT EXISTS face_result varchar(12)
    CHECK (face_result IS NULL OR face_result IN ('match', 'mismatch', 'enrolled', 'unchecked')),
  ADD COLUMN IF NOT EXISTS face_score real;
--> statement-breakpoint
-- One reference face per member: the SFace feature and the photo it came
-- from. Removed when the member is switched off clocking.
CREATE TABLE IF NOT EXISTS inventory.attendance_face_refs (
  member_id        uuid PRIMARY KEY REFERENCES auth.members(id) ON DELETE CASCADE,
  org_id           uuid NOT NULL REFERENCES auth.organizations(id) ON DELETE CASCADE,
  feature          real[] NOT NULL CHECK (cardinality(feature) = 128),
  bytes            bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 600000),
  source_punch_id  uuid REFERENCES inventory.attendance_punches(id) ON DELETE SET NULL,
  set_by_member_id uuid,
  set_at           timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS afr_org_idx ON inventory.attendance_face_refs (org_id);
