/**
 * Create the test login role named on the command line in the database at
 * DATABASE_URL (appRole.ts). CI runs it before the integration tests:
 *
 *   DATABASE_URL=… bun run src/create-app-role.ts compass_ci_app
 */
import postgres from 'postgres';
import { appRoleSql } from './appRole';

const role = process.argv[2];
const url = process.env.DATABASE_URL;
if (!role || !url) {
  console.error('usage: DATABASE_URL=… bun run src/create-app-role.ts <role>');
  process.exit(2);
}
const db = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
try {
  await db.unsafe(appRoleSql(role));
} finally {
  await db.end({ timeout: 5 });
}
