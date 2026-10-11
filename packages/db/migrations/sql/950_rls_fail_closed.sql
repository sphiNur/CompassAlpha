-- Runs after 900_rls_policies.sql on every migrate.
--
-- Some policies are created by numbered migrations rather than by the file
-- above, written when "no tenant set" still meant "let it through". This
-- rewrites any policy that still carries that condition, wherever it came
-- from, so that one stale copy of the old pattern cannot reopen the hole.
-- Idempotent: once nothing matches, it does nothing.
DO $$
DECLARE
  p record;
  new_qual text;
  new_check text;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE qual LIKE '%app_current_org() IS NULL%'
       OR with_check LIKE '%app_current_org() IS NULL%'
  LOOP
    new_qual := replace(p.qual, 'app_current_org() IS NULL', 'app_is_system()');
    new_check := replace(p.with_check, 'app_current_org() IS NULL', 'app_is_system()');
    EXECUTE format(
      'ALTER POLICY %I ON %I.%I%s%s',
      p.policyname,
      p.schemaname,
      p.tablename,
      CASE WHEN new_qual IS NOT NULL THEN format(' USING (%s)', new_qual) ELSE '' END,
      CASE WHEN new_check IS NOT NULL THEN format(' WITH CHECK (%s)', new_check) ELSE '' END
    );
  END LOOP;
END $$;
