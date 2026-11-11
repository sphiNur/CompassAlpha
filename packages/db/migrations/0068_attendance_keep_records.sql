-- 0068_attendance_keep_records.sql
--
-- Attendance review, 2026-11-07:
--
-- * A member's attendance stays when the member is removed (owner decision):
--   punches, shifts, daily wages and overtime no longer go with the member
--   row. admin.memberRemove refuses someone with attendance and asks to
--   suspend them instead. Removing a whole organisation still removes its
--   attendance (NO ACTION is checked at the end of the statement, after the
--   organisation's own cascades). An organisation with a daily close cannot
--   be removed at all: its settlement revisions refuse DELETE (0037).
-- * Frame prints for each accepted self punch: a SHA-256 and the SFace
--   feature of every frame (straight, blink, open mouth, turns). A frame
--   sent again later, or one of the person's enrollment photos, is refused,
--   so saved pictures cannot clock someone who is not there. Kept 90 days,
--   like the photos.

SELECT set_config('app.system_context', 'maintenance', true);
--> statement-breakpoint
ALTER TABLE inventory.attendance_shifts DROP CONSTRAINT IF EXISTS attendance_shifts_member_id_fkey;
--> statement-breakpoint
ALTER TABLE inventory.attendance_shifts ADD CONSTRAINT attendance_shifts_member_id_fkey
  FOREIGN KEY (member_id) REFERENCES auth.members(id) ON DELETE NO ACTION;
--> statement-breakpoint
ALTER TABLE inventory.attendance_punches DROP CONSTRAINT IF EXISTS attendance_punches_member_id_fkey;
--> statement-breakpoint
ALTER TABLE inventory.attendance_punches ADD CONSTRAINT attendance_punches_member_id_fkey
  FOREIGN KEY (member_id) REFERENCES auth.members(id) ON DELETE NO ACTION;
--> statement-breakpoint
ALTER TABLE inventory.attendance_pay_rates DROP CONSTRAINT IF EXISTS attendance_pay_rates_member_id_fkey;
--> statement-breakpoint
ALTER TABLE inventory.attendance_pay_rates ADD CONSTRAINT attendance_pay_rates_member_id_fkey
  FOREIGN KEY (member_id) REFERENCES auth.members(id) ON DELETE NO ACTION;
--> statement-breakpoint
ALTER TABLE inventory.attendance_overtime DROP CONSTRAINT IF EXISTS attendance_overtime_member_id_fkey;
--> statement-breakpoint
ALTER TABLE inventory.attendance_overtime ADD CONSTRAINT attendance_overtime_member_id_fkey
  FOREIGN KEY (member_id) REFERENCES auth.members(id) ON DELETE NO ACTION;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS inventory.attendance_punch_frames (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES auth.organizations(id) ON DELETE CASCADE,
  member_id  uuid NOT NULL REFERENCES auth.members(id) ON DELETE CASCADE,
  punch_id   uuid NOT NULL REFERENCES inventory.attendance_punches(id) ON DELETE CASCADE,
  kind       varchar(8) NOT NULL CHECK (kind IN ('face', 'blink', 'mouth', 'left', 'right')),
  sha256     bytea NOT NULL CHECK (octet_length(sha256) = 32),
  feature    real[] NOT NULL CHECK (cardinality(feature) = 128),
  taken_at   timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS apf_member_taken_idx
  ON inventory.attendance_punch_frames (member_id, taken_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS apf_taken_idx ON inventory.attendance_punch_frames (taken_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS apf_org_idx ON inventory.attendance_punch_frames (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS apf_punch_idx ON inventory.attendance_punch_frames (punch_id);
