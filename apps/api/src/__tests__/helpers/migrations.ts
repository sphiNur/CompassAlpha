/**
 * A migration of packages/db run again on the test database (review
 * TEST2-18, 2026-11). A test of a backfill shows what it does to rows the
 * test has set up; the tests used to read the SQL file and look for words
 * in it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { getDb } from '@compass/db';

/** packages/db/migrations, found through the package, not a relative path. */
const MIGRATIONS = join(
  dirname(fileURLToPath(import.meta.resolve('@compass/db'))),
  '../migrations',
);

/**
 * Runs migration `file` (e.g. `0048_backfill_builtin_role_permissions.sql`)
 * statement by statement in one transaction, in the maintenance context,
 * as the migration runner does.
 */
export async function rerunMigration(file: string): Promise<void> {
  const text = readFileSync(join(MIGRATIONS, file), 'utf8');
  const statements = text
    .split('--> statement-breakpoint')
    .filter((statement) => statement.replace(/--.*$/gm, '').trim());
  await getDb(undefined, { system: 'maintenance' }).transaction(async (tx) => {
    for (const statement of statements) await tx.execute(sql.raw(statement));
  });
}
