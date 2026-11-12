/**
 * A login role for test databases that queries the way the api does in
 * production: no superuser, no BYPASSRLS, all privileges on the app's
 * schemas, so every query goes through the row-level security policies.
 * CI's integration tests and the e2e run both use it (review OPS-30: each
 * kept its own copy of this SQL, and a new schema had to be added twice).
 *
 * Test databases only: the password is the role name.
 */

/** The schemas the app's tables live in (drizzle's own is not one). */
export const APP_SCHEMAS = ['auth', 'inventory', 'domain', 'read_model', 'ops', 'sync'] as const;

/** SQL that creates `role`, or resets it when it exists, and grants it the app's schemas. */
export function appRoleSql(role: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error(`not a plain role name: ${role}`);
  const schemas = APP_SCHEMAS.join(', ');
  return `
    DO $$
    BEGIN
      CREATE ROLE ${role} LOGIN PASSWORD '${role}' NOSUPERUSER NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object THEN
      ALTER ROLE ${role} WITH LOGIN PASSWORD '${role}' NOSUPERUSER NOBYPASSRLS;
    END $$;
    GRANT USAGE ON SCHEMA ${schemas}, public TO ${role};
    GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schemas} TO ${role};
    GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schemas} TO ${role};
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schemas}, public TO ${role};
  `;
}
