-- 0061_attendance_pay.sql
--
-- Attendance phase 2 (owner decisions 2026-11-05): daily wage per person,
-- late / early deductions, and overtime that counts only once a manager
-- approves it (a clock-out well past the shift needs the person's reason).

SELECT set_config('app.system_context', 'maintenance', true);
--> statement-breakpoint
-- A daily wage from a date on. A raise adds a row; past days keep the
-- rate they were worked at.
CREATE TABLE IF NOT EXISTS inventory.attendance_pay_rates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES auth.organizations(id) ON DELETE CASCADE,
  member_id        uuid NOT NULL REFERENCES auth.members(id) ON DELETE CASCADE,
  daily_wage       numeric(14, 2) NOT NULL CHECK (daily_wage >= 0),
  effective_from   date NOT NULL,
  created_by_member_id uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, effective_from)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS apr_org_idx ON inventory.attendance_pay_rates (org_id);
--> statement-breakpoint
-- Time past the end of a shift. One row per clock-out punch; it counts
-- once approved. Voiding the punch drops it from every total.
CREATE TABLE IF NOT EXISTS inventory.attendance_overtime (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES auth.organizations(id) ON DELETE CASCADE,
  store_id         uuid NOT NULL REFERENCES inventory.stores(id) ON DELETE CASCADE,
  member_id        uuid NOT NULL REFERENCES auth.members(id) ON DELETE CASCADE,
  shift_id         uuid REFERENCES inventory.attendance_shifts(id) ON DELETE SET NULL,
  punch_id         uuid NOT NULL UNIQUE REFERENCES inventory.attendance_punches(id) ON DELETE CASCADE,
  minutes          integer NOT NULL CHECK (minutes > 0 AND minutes <= 1440),
  reason           text CHECK (reason IS NULL OR char_length(reason) <= 300),
  status           varchar(10) NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by_member_id uuid,
  decided_at       timestamptz,
  decision_note    text CHECK (decision_note IS NULL OR char_length(decision_note) <= 300),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'pending') = (decided_at IS NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS aot_store_idx ON inventory.attendance_overtime (store_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS aot_org_idx ON inventory.attendance_overtime (org_id);
--> statement-breakpoint
ALTER TABLE inventory.attendance_store_policies
  ADD COLUMN IF NOT EXISTS overtime_after_minutes integer NOT NULL DEFAULT 30
    CHECK (overtime_after_minutes BETWEEN 5 AND 240);
