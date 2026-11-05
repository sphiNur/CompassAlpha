-- 0060_attendance.sql
--
-- Clock-in / clock-out attendance (owner request 2026-11-05).
--
-- Who clocks is decided per member, not per role: the member gets the
-- `attendance.clock` permission as a global allow override (switched on
-- in the member's settings). Store managers get `attendance.manage` for
-- their stores: the roster, the attendance sheet, manual punches and the
-- store's clock-in rules.
--
-- Punches are an audit record: rows are never deleted, and the only
-- update allowed is voiding a punch once, with a reason. A manager's
-- correction is a new `manual` punch plus the void of the wrong one.

SELECT set_config('app.system_context', 'maintenance', true);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS inventory.attendance_store_policies (
  store_id         uuid PRIMARY KEY REFERENCES inventory.stores(id) ON DELETE CASCADE,
  org_id           uuid NOT NULL REFERENCES auth.organizations(id) ON DELETE CASCADE,
  require_device   boolean NOT NULL DEFAULT true,
  require_geo      boolean NOT NULL DEFAULT false,
  geo_lat          numeric(9, 6) CHECK (geo_lat IS NULL OR geo_lat BETWEEN -90 AND 90),
  geo_lng          numeric(9, 6) CHECK (geo_lng IS NULL OR geo_lng BETWEEN -180 AND 180),
  geo_radius_m     integer CHECK (geo_radius_m IS NULL OR geo_radius_m BETWEEN 20 AND 5000),
  require_ip       boolean NOT NULL DEFAULT false,
  allowed_ips      text[] NOT NULL DEFAULT '{}',
  grace_minutes    integer NOT NULL DEFAULT 5 CHECK (grace_minutes BETWEEN 0 AND 120),
  updated_by_member_id uuid REFERENCES auth.members(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT require_geo OR (geo_lat IS NOT NULL AND geo_lng IS NOT NULL AND geo_radius_m IS NOT NULL)),
  CHECK (NOT require_ip OR cardinality(allowed_ips) > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS asp_org_idx ON inventory.attendance_store_policies (org_id);
--> statement-breakpoint
-- One bound phone per member. The client keeps a random id on the device;
-- only its SHA-256 is stored.
CREATE TABLE IF NOT EXISTS inventory.attendance_devices (
  member_id        uuid PRIMARY KEY REFERENCES auth.members(id) ON DELETE CASCADE,
  org_id           uuid NOT NULL REFERENCES auth.organizations(id) ON DELETE CASCADE,
  device_hash      text NOT NULL CHECK (char_length(device_hash) = 64),
  platform         varchar(32),
  bound_at         timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ad_org_idx ON inventory.attendance_devices (org_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS inventory.attendance_shifts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES auth.organizations(id) ON DELETE CASCADE,
  store_id         uuid NOT NULL REFERENCES inventory.stores(id) ON DELETE CASCADE,
  member_id        uuid NOT NULL REFERENCES auth.members(id) ON DELETE CASCADE,
  shift_date       date NOT NULL,
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  note             text CHECK (note IS NULL OR char_length(note) <= 200),
  created_by_member_id uuid REFERENCES auth.members(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at AND ends_at - starts_at <= interval '24 hours')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ash_store_date_idx ON inventory.attendance_shifts (store_id, shift_date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ash_member_date_idx ON inventory.attendance_shifts (member_id, shift_date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ash_org_idx ON inventory.attendance_shifts (org_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS inventory.attendance_punches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES auth.organizations(id) ON DELETE CASCADE,
  store_id         uuid NOT NULL REFERENCES inventory.stores(id) ON DELETE CASCADE,
  member_id        uuid NOT NULL REFERENCES auth.members(id) ON DELETE CASCADE,
  kind             varchar(3) NOT NULL CHECK (kind IN ('in', 'out')),
  punched_at       timestamptz NOT NULL,
  source           varchar(8) NOT NULL CHECK (source IN ('self', 'manual')),
  geo_lat          numeric(9, 6),
  geo_lng          numeric(9, 6),
  geo_accuracy_m   integer,
  distance_m       integer,
  client_ip        text,
  reason           text CHECK (reason IS NULL OR char_length(reason) <= 300),
  -- Deliberately not FKs: the audit actor survives membership removal.
  created_by_member_id uuid NOT NULL,
  voided_at        timestamptz,
  voided_by_member_id uuid,
  void_reason      text CHECK (void_reason IS NULL OR char_length(void_reason) <= 300),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (source = 'self' OR reason IS NOT NULL),
  CHECK ((voided_at IS NULL) = (void_reason IS NULL) AND (voided_at IS NULL) = (voided_by_member_id IS NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ap_store_time_idx ON inventory.attendance_punches (store_id, punched_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ap_member_time_idx ON inventory.attendance_punches (member_id, punched_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ap_org_idx ON inventory.attendance_punches (org_id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION inventory.guard_attendance_punch() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Organisation / store / member deletion cascades; a direct delete does not.
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'attendance punches are never deleted; void them instead';
  END IF;
  IF OLD.voided_at IS NOT NULL
     OR NEW.voided_at IS NULL
     OR (to_jsonb(NEW) - 'voided_at' - 'voided_by_member_id' - 'void_reason')
        <> (to_jsonb(OLD) - 'voided_at' - 'voided_by_member_id' - 'void_reason') THEN
    RAISE EXCEPTION 'an attendance punch can only be voided, once';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS ap_guard ON inventory.attendance_punches;
--> statement-breakpoint
CREATE TRIGGER ap_guard
  BEFORE UPDATE OR DELETE ON inventory.attendance_punches
  FOR EACH ROW EXECUTE FUNCTION inventory.guard_attendance_punch();
--> statement-breakpoint
INSERT INTO auth.permissions (key, description) VALUES
  ('attendance.clock', 'Clock in and out at assigned stores'),
  ('attendance.manage', 'Plan shifts, review and correct attendance for a store')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
-- Built-in roles that manage a store's people (manager; admin and
-- super_admin hold every management key) get attendance.manage.
-- attendance.clock stays per member.
INSERT INTO auth.role_permissions (role_id, permission_key)
SELECT r.id, 'attendance.manage'
FROM auth.roles r
WHERE r.is_built_in = true AND r.slug IN ('super_admin', 'admin', 'manager')
ON CONFLICT DO NOTHING;
