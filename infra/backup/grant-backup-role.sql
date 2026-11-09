-- Privileges for the nightly backup role (review OPS-02, 2026-11-09).
--
-- pg_dump needs SELECT on every table and sequence it dumps. A GRANT on
-- the tables that exist today does not reach a table a later migration
-- creates: from 2026-08 to 2026-11 every nightly backup failed on one,
-- and nothing said so. ALTER DEFAULT PRIVILEGES covers future tables, but
-- only those created by the role named in FOR ROLE, so `owner` must be the
-- role the migrations connect as (the user in DATABASE_URL_DIRECT, or
-- DATABASE_URL when that is unset).
--
-- Run as a superuser, after creating the role once with
--   CREATE ROLE compass_backup LOGIN BYPASSRLS PASSWORD '…';
-- and again whenever a migration adds a schema:
--   sudo -u postgres psql -d compass -v backup=compass_backup -v owner=compass \
--     -f /home/ubuntu/compass-alpha/infra/backup/grant-backup-role.sql
-- Idempotent.

\set ON_ERROR_STOP on

GRANT USAGE ON SCHEMA auth, domain, drizzle, inventory, ops, public, read_model, sync
  TO :"backup";

GRANT SELECT ON ALL TABLES IN SCHEMA auth, domain, drizzle, inventory, ops, public, read_model, sync
  TO :"backup";

GRANT SELECT ON ALL SEQUENCES IN SCHEMA auth, domain, drizzle, inventory, ops, public, read_model, sync
  TO :"backup";

ALTER DEFAULT PRIVILEGES FOR ROLE :"owner"
  IN SCHEMA auth, domain, drizzle, inventory, ops, public, read_model, sync
  GRANT SELECT ON TABLES TO :"backup";

ALTER DEFAULT PRIVILEGES FOR ROLE :"owner"
  IN SCHEMA auth, domain, drizzle, inventory, ops, public, read_model, sync
  GRANT SELECT ON SEQUENCES TO :"backup";
