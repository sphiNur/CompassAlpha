-- Extensions + logical schemas. Idempotent.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS inventory;
CREATE SCHEMA IF NOT EXISTS domain;
CREATE SCHEMA IF NOT EXISTS read_model;
CREATE SCHEMA IF NOT EXISTS ops;
CREATE SCHEMA IF NOT EXISTS sync;

-- Helper referenced by several generated migrations before the
-- post-migration RLS policy script runs. 900_rls_policies.sql defines it
-- again, identically; this copy has to exist first.
CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.current_org_id', true), '')::uuid
$$ LANGUAGE SQL STABLE;

-- Review DB-23 (2026-11-12): this sets the setting for the migration's own
-- session only, and is no default for anything else: each request sets
-- its organisation inside its transaction (packages/db/src/rls.ts), and an
-- unset setting reads as no organisation just as '' does.
DO $$ BEGIN
  PERFORM set_config('app.current_org_id', '', false);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
