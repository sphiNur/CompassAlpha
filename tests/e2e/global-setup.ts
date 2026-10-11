/**
 * Rebuild the database from nothing before every run: migrations, the
 * development seed (one org, two stores, a small catalog) and a single
 * super admin for the dev login to pick up.
 *
 * Starting clean is what lets the flow assert exact numbers. It also
 * means every run exercises the real migration chain on an empty
 * database.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { ADMIN_TG_ID, APP_ROLE, DATABASE_URL } from './env';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMAS = ['auth', 'inventory', 'domain', 'read_model', 'ops', 'sync', 'drizzle'];

function pnpm(args: string[]): void {
  execFileSync('pnpm', args, {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, DATABASE_URL, DATABASE_URL_DIRECT: DATABASE_URL },
  });
}

export default async function globalSetup(): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    for (const schema of SCHEMAS) {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  pnpm(['--filter', '@compass/db', 'migrate']);
  pnpm(['--filter', '@compass/db', 'seed']);
  pnpm(['compass', 'user', 'grant', ADMIN_TG_ID, '--role', 'super_admin', '--org', 'default']);

  // The role the api runs as; see APP_DATABASE_URL.
  const owner = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const schemas = SCHEMAS.filter((name) => name !== 'drizzle').join(', ');
    await owner.unsafe(`
      DO $$
      BEGIN
        CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_ROLE}' NOSUPERUSER NOBYPASSRLS;
      EXCEPTION WHEN duplicate_object THEN
        ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${APP_ROLE}' NOSUPERUSER NOBYPASSRLS;
      END $$;
      GRANT USAGE ON SCHEMA ${schemas}, public TO ${APP_ROLE};
      GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schemas} TO ${APP_ROLE};
      GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schemas} TO ${APP_ROLE};
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schemas}, public TO ${APP_ROLE};
    `);
  } finally {
    await owner.end({ timeout: 5 });
  }
}
