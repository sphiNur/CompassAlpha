-- 0069_attendance_review_org_index.sql
--
-- Review DB-10 (2026-11-11). 0065 created the org_id index of
-- inventory.attendance_punch_reviews as `apr_org_idx`, a name 0061 had
-- already given to the org_id index of inventory.attendance_pay_rates.
-- Index names are unique within a schema, so CREATE INDEX IF NOT EXISTS
-- found the name taken and skipped the statement without an error: the
-- reviews table never had the index its RLS predicate and the
-- organisation cascade read. It gets one here, under its own name.
--
-- The table is small; a plain CREATE INDEX holds its write lock for a
-- moment only.

CREATE INDEX IF NOT EXISTS apr_reviews_org_idx ON inventory.attendance_punch_reviews (org_id);
