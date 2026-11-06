-- 0065_attendance_checks.sql
--
-- Clocking on people's own phones, made lighter and easier to review
-- (owner decisions 2026-11-06; stores cannot keep a fixed clock device):
--
-- * The place photo is its own switch, off by default.
-- * Liveness turns only on a risk signal or a 1-in-3 spot check; other
--   punches carry one face photo checked by the real-face model
--   (liveness = 'passive').
-- * The face is identified among the store's people: a mismatch names
--   who it looks like, and a colleague is clocked on a borrowed phone by
--   their face alone.
-- * Managers clear flagged punches from one list (punch reviews; punches
--   themselves are never updated).
-- * A person agrees in the app before their face is registered.

SELECT set_config('app.system_context', 'maintenance', true);
--> statement-breakpoint
ALTER TABLE inventory.attendance_store_policies
  ADD COLUMN IF NOT EXISTS require_scene boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE inventory.attendance_punches DROP CONSTRAINT IF EXISTS attendance_punches_liveness_check;
--> statement-breakpoint
ALTER TABLE inventory.attendance_punches
  ADD CONSTRAINT attendance_punches_liveness_check
    CHECK (liveness IS NULL OR liveness IN ('pass', 'passive', 'fail', 'unchecked'));
--> statement-breakpoint
ALTER TABLE inventory.attendance_photos
  ADD COLUMN IF NOT EXISTS face_like_member_id uuid REFERENCES auth.members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS real_score real;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS inventory.attendance_punch_reviews (
  punch_id              uuid PRIMARY KEY REFERENCES inventory.attendance_punches(id) ON DELETE CASCADE,
  org_id                uuid NOT NULL REFERENCES auth.organizations(id) ON DELETE CASCADE,
  store_id              uuid NOT NULL REFERENCES inventory.stores(id) ON DELETE CASCADE,
  reviewed_by_member_id uuid,
  reviewed_at           timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS apr_org_idx ON inventory.attendance_punch_reviews (org_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS inventory.attendance_face_consents (
  member_id     uuid PRIMARY KEY REFERENCES auth.members(id) ON DELETE CASCADE,
  org_id        uuid NOT NULL REFERENCES auth.organizations(id) ON DELETE CASCADE,
  version       integer NOT NULL,
  consented_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS afc_org_idx ON inventory.attendance_face_consents (org_id);
