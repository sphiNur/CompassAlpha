-- 0062_attendance_photos.sql
--
-- Clock-in photos (owner request 2026-11-05): a store can ask every self
-- punch for two photos taken on the spot — the person's face (front
-- camera), then the surroundings (rear camera). Photos are kept 90 days
-- (the API deletes older ones) and only managers of the store see them.

SELECT set_config('app.system_context', 'maintenance', true);
--> statement-breakpoint
ALTER TABLE inventory.attendance_store_policies
  ADD COLUMN IF NOT EXISTS require_photo boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS inventory.attendance_photos (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES auth.organizations(id) ON DELETE CASCADE,
  store_id         uuid NOT NULL REFERENCES inventory.stores(id) ON DELETE CASCADE,
  member_id        uuid NOT NULL REFERENCES auth.members(id) ON DELETE CASCADE,
  punch_id         uuid NOT NULL REFERENCES inventory.attendance_punches(id) ON DELETE CASCADE,
  kind             varchar(8) NOT NULL CHECK (kind IN ('face', 'scene')),
  content_type     varchar(32) NOT NULL DEFAULT 'image/jpeg',
  bytes            bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 600000),
  taken_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (punch_id, kind)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS aph_taken_idx ON inventory.attendance_photos (taken_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS aph_org_idx ON inventory.attendance_photos (org_id);
