/**
 * Rebuild the database from nothing before every run: migrations, the
 * development seed (one org, two stores, a small catalog) and a single
 * super admin for the dev login to pick up.
 *
 * Starting clean is what lets the flow assert exact numbers. It also
 * means every run exercises the real migration chain on an empty
 * database.
 *
 * The tutorial screenshots (tutorial/) start the same way and seed their
 * own workspace instead of the development seed: `pnpmAtRoot`,
 * `resetDatabase` and `createAppRole` are shared with them.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_SCHEMAS, appRoleSql } from '@compass/db/app-role';
import postgres from 'postgres';
import { ADMIN_TG_ID, APP_ROLE, DATABASE_URL } from './env';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMAS = [...APP_SCHEMAS, 'drizzle'];

/** pnpm at the repository root, against the run's database. */
export function pnpmAtRoot(args: string[]): void {
  execFileSync('pnpm', args, {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, DATABASE_URL, DATABASE_URL_DIRECT: DATABASE_URL },
  });
}

/** Drop every application schema and migrate from nothing. */
export async function resetDatabase(): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    for (const schema of SCHEMAS) {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  pnpmAtRoot(['--filter', '@compass/db', 'migrate']);
}

/** The role the api runs as; see APP_DATABASE_URL. */
export async function createAppRole(): Promise<void> {
  const owner = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await owner.unsafe(appRoleSql(APP_ROLE));
  } finally {
    await owner.end({ timeout: 5 });
  }
}

export default async function globalSetup(): Promise<void> {
  await resetDatabase();
  pnpmAtRoot(['--filter', '@compass/db', 'seed']);
  pnpmAtRoot([
    'compass',
    'user',
    'grant',
    ADMIN_TG_ID,
    '--role',
    'super_admin',
    '--org',
    'default',
    // A fresh database has no account for this id; the dev login uses it.
    '--new-user',
  ]);
  await createAppRole();
}
