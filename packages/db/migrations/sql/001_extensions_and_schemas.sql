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

-- Default GUC for RLS — empty string means "no org context, deny everything".
DO $$ BEGIN
  PERFORM set_config('app.current_org_id', '', false);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
