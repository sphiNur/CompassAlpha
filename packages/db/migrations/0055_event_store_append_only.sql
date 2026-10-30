-- 0055_event_store_append_only.sql
--
-- D1 (2026-10-30): domain.events is the source of truth that every read
-- model is rebuilt from, yet the application could UPDATE, DELETE and
-- TRUNCATE it like any other table. A REVOKE would not help: the role
-- the API connects as owns the tables and runs the migrations, and an
-- owner can always grant itself back. So the table refuses the change
-- itself, whoever asks.
--
-- What still goes through, and why:
--   * A deliberate maintenance purge (admin purge of a session, a run, a
--     date or a whole workspace; packages/db/src/purge-fake-data.ts).
--     That code first calls allowEventPurge(tx) (packages/db/src/rls.ts),
--     which sets app.event_purge = 'on' for its own transaction only.
--   * The foreign keys that already exist: deleting an organisation
--     cascades to its events, and deleting a user sets actor_id to NULL
--     on theirs. Both are recognised by the parent row being gone; a
--     plain DELETE or UPDATE cannot fake that. Whether those cascades
--     should exist at all is a separate question (D6/D7).
--
-- Plain INSERT is untouched. Existing rows are not read or changed, so
-- this applies instantly on any amount of data.
CREATE OR REPLACE FUNCTION domain.reject_event_mutation()
RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('app.event_purge', true), '') = 'on' THEN
    IF TG_OP = 'TRUNCATE' THEN
      RETURN NULL;
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM auth.organizations o WHERE o.id = OLD.org_id) THEN
      RETURN OLD;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.actor_id IS NOT NULL
       AND NEW.actor_id IS NULL
       AND (to_jsonb(NEW) - 'actor_id') = (to_jsonb(OLD) - 'actor_id')
       AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.actor_id) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'domain.events is append-only (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS events_reject_mutation ON domain.events;
--> statement-breakpoint
CREATE TRIGGER events_reject_mutation
  BEFORE UPDATE OR DELETE ON domain.events
  FOR EACH ROW EXECUTE FUNCTION domain.reject_event_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS events_reject_truncate ON domain.events;
--> statement-breakpoint
CREATE TRIGGER events_reject_truncate
  BEFORE TRUNCATE ON domain.events
  FOR EACH STATEMENT EXECUTE FUNCTION domain.reject_event_mutation();
