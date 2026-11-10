/**
 * Migration runner.
 *
 * Order:
 *   1. PRE raw SQL (`migrations/sql/0*.sql`) — schemas, extensions, functions
 *      that drizzle's generated DDL will reference.
 *   2. drizzle generated SQL (creates tables + indexes inside schemas).
 *   3. POST raw SQL (`migrations/sql/9*.sql`) — RLS policies, triggers.
 *
 * Drizzle applies the pending migrations in one transaction and records
 * each one, so a failed batch rolls back and a re-run starts where it
 * stopped; raw SQL uses IF NOT EXISTS / DROP+CREATE patterns. That holds
 * only while no migration commits on its own. 23 early files do
 * (`LEGACY_TRANSACTION_CONTROL`); after the first of them in a batch (a
 * fresh database) statements run one by one, and a failure there can
 * leave a migration half applied. New files may not (checked below).
 *
 * `--pending` only lists the entries a run would apply (review OPS-10:
 * the deploy takes a backup first when there is one).
 */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import {
  journalOrderProblems,
  pendingMigrations,
  transactionControlViolations,
  unreachableMigrations,
  type JournalEntry,
} from './migrationLint';
import { LOCK_TIMEOUT, retryOnLockTimeout } from './migrateLocks';
import { loadRepoEnv } from './repoEnv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsRoot = join(__dirname, '..', 'migrations');
const rawSqlDir = join(migrationsRoot, 'sql');
const journalPath = join(migrationsRoot, 'meta', '_journal.json');

loadRepoEnv(import.meta.url);

async function runRawSql(
  client: ReturnType<typeof postgres>,
  predicate: (file: string) => boolean,
) {
  let files: string[] = [];
  try {
    files = (await readdir(rawSqlDir)).filter((f) => f.endsWith('.sql') && predicate(f)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  for (const file of files) {
    const sqlText = await readFile(join(rawSqlDir, file), 'utf8');
    console.log(`  · ${file}`);
    // One implicit transaction per file, safe to run again (DB-08).
    await retryOnLockTimeout(file, () => client.unsafe(sqlText));
  }
}

/** The entries of `migrations/meta/_journal.json`. */
function readJournal(): JournalEntry[] {
  if (!existsSync(journalPath)) {
    throw new Error(`[migrate] journal not found at ${journalPath}`);
  }
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries?: JournalEntry[];
  };
  return journal.entries ?? [];
}

/**
 * Cross-check (M1.7, 2026-05-06): every drizzle SQL file in
 * `migrations/` MUST have a matching entry in
 * `migrations/meta/_journal.json`, and vice versa.
 *
 * Why: the drizzle migrator only runs files that are listed in the
 * journal. If you add a new `0009_xxx.sql` file by hand and forget
 * to update `_journal.json`, the migrator silently skips it and
 * prints "Done." Production then carries half-applied schema while
 * deploys claim "GREEN." This bit us in M1.2B (lost 0009 for a week,
 * `auditAdmin` writes were silently failing in prod, Stores screen
 * threw on the missing column once we surfaced it).
 *
 * This function fails the migrate run BEFORE the drizzle migrator
 * touches the DB, so a mismatch can't accidentally ship.
 *
 * Two failure modes:
 *   - Orphan: SQL file exists but no journal entry → drizzle would
 *     silently skip. THE bug we just fixed.
 *   - Ghost:  journal entry exists but SQL file is missing → drizzle
 *     would error out at apply time anyway, but we'd rather catch
 *     before partial migrations.
 */
async function checkMigrationJournalConsistency(): Promise<void> {
  const journalTags = new Set(readJournal().map((e) => e.tag));

  let sqlFiles: string[] = [];
  try {
    sqlFiles = (await readdir(migrationsRoot))
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .map((f) => f.replace(/\.sql$/, ''));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const sqlSet = new Set(sqlFiles);

  const orphans = sqlFiles.filter((t) => !journalTags.has(t));
  const ghosts = [...journalTags].filter((t) => !sqlSet.has(t));

  if (orphans.length === 0 && ghosts.length === 0) return;

  if (orphans.length > 0) {
    console.error(
      `[migrate] ORPHAN migration SQL files (present in migrations/ but missing from meta/_journal.json — drizzle WILL silently skip them):`,
    );
    for (const t of orphans) console.error(`  ✗ ${t}.sql`);
  }
  if (ghosts.length > 0) {
    console.error(
      `[migrate] GHOST journal entries (listed in meta/_journal.json but no matching SQL file):`,
    );
    for (const t of ghosts) console.error(`  ✗ ${t}`);
  }
  throw new Error(
    'Migration journal/file mismatch. Fix meta/_journal.json (add missing entries OR remove ghost ones) before deploying.',
  );
}

/**
 * Review DB-01 (2026-11-09): a migration may not BEGIN or COMMIT. The
 * runner owns the transaction (see `migrationLint.ts`). Fails before the
 * drizzle migrator touches the database.
 */
async function checkNoTransactionControl(): Promise<void> {
  const files = (await readdir(migrationsRoot)).filter((f) => /^\d{4}_.*\.sql$/.test(f));
  const violations = transactionControlViolations(
    await Promise.all(
      files.map(async (f) => ({
        tag: f.replace(/\.sql$/, ''),
        sql: await readFile(join(migrationsRoot, f), 'utf8'),
      })),
    ),
  );
  if (violations.length === 0) return;
  console.error('[migrate] Migrations that control the transaction themselves:');
  for (const v of violations) console.error(`  ✗ ${v.tag}.sql: ${v.statements.join(' ')}`);
  throw new Error(
    'Remove BEGIN/COMMIT/ROLLBACK from these migrations. The runner applies each batch in one transaction and sets the maintenance system context for the whole session.',
  );
}

/**
 * Review DB-07 (2026-11-10): `idx` counts up from 0 and each `when` is
 * later than the one before (see `journalOrderProblems`). Fails before the
 * drizzle migrator touches the database.
 */
function checkJournalOrder(entries: readonly JournalEntry[]): void {
  const problems = journalOrderProblems(entries);
  if (problems.length === 0) return;
  console.error('[migrate] meta/_journal.json is out of order:');
  for (const p of problems) console.error(`  ✗ ${p}`);
  throw new Error(
    'Put meta/_journal.json in order: idx counts up from 0, and each `when` is later than the one before.',
  );
}

/** The `created_at` of each migration the database recorded; none for a new database. */
async function recordedMigrations(client: ReturnType<typeof postgres>): Promise<number[]> {
  const [table] = await client<{ name: string | null }[]>`
    select to_regclass('drizzle.__drizzle_migrations')::text as name`;
  // A new database: drizzle creates the table and applies everything.
  if (!table?.name) return [];
  const rows = await client<{ createdAt: string | null }[]>`
    select created_at::text as "createdAt" from drizzle.__drizzle_migrations`;
  return rows.flatMap((r) => (r.createdAt === null ? [] : [Number(r.createdAt)]));
}

/**
 * Review DB-07 (2026-11-10): no entry may be dated before the newest
 * migration this database recorded unless it is recorded too. Drizzle
 * would pass over it without a word (see `unreachableMigrations`).
 */
async function checkNothingSkipped(
  client: ReturnType<typeof postgres>,
  entries: readonly JournalEntry[],
): Promise<void> {
  const recorded = await recordedMigrations(client);
  const skipped = unreachableMigrations(entries, recorded);
  if (skipped.length === 0) return;
  const newest = Math.max(...recorded);
  console.error(
    `[migrate] Journal entries this database would never apply (dated before its newest recorded migration, ${newest}):`,
  );
  for (const e of skipped) console.error(`  ✗ ${e.tag} (when ${e.when})`);
  throw new Error(
    'Move these entries to the end of meta/_journal.json, each with a `when` after the newest recorded one, before deploying.',
  );
}

async function main() {
  const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }
  // Review DB-01 (2026-11-09): the system context is set for the whole
  // session. Backfills under FORCE RLS used to rely on each file's
  // `set_config(..., true)`, which an earlier file's COMMIT cut down to a
  // single statement: the INSERT … SELECT after it saw no rows, wrote
  // nothing, and the migration was recorded as applied.
  // Review DB-08 (2026-11-10): no statement waits longer than LOCK_TIMEOUT
  // for a lock, so the live app is never held up longer (migrateLocks.ts).
  const client = postgres(url, {
    max: 1,
    prepare: false,
    connection: { 'app.system_context': 'maintenance', lock_timeout: LOCK_TIMEOUT } as Record<
      string,
      string
    >,
  });
  const db = drizzle(client);

  // Review OPS-10 (2026-11): a `pending: <tag>` line for each entry the
  // next run applies, before anything below changes the database.
  if (process.argv.includes('--pending')) {
    const pending = pendingMigrations(readJournal(), await recordedMigrations(client));
    for (const entry of pending) console.log(`pending: ${entry.tag}`);
    await client.end({ timeout: 5 });
    return;
  }

  console.log('[migrate] PRE SQL (extensions, schemas, functions)...');
  await runRawSql(client, (f) => /^0\d/.test(f));

  console.log('[migrate] Checking journal/SQL file consistency...');
  await checkMigrationJournalConsistency();
  const journal = readJournal();

  console.log('[migrate] Checking the journal order...');
  checkJournalOrder(journal);

  console.log('[migrate] Checking that no migration controls the transaction...');
  await checkNoTransactionControl();

  console.log('[migrate] Checking that the database would apply every pending entry...');
  await checkNothingSkipped(client, journal);

  console.log('[migrate] Drizzle migrations...');
  // The pending batch is one transaction: a failed try leaves nothing.
  await retryOnLockTimeout('drizzle migrations', () =>
    migrate(db, { migrationsFolder: migrationsRoot }),
  );

  console.log('[migrate] POST SQL (RLS policies, triggers)...');
  await runRawSql(client, (f) => /^[1-9]/.test(f));

  await client.end({ timeout: 5 });
  console.log('[migrate] Done.');
}

main().catch((err) => {
  console.error('[migrate] FAILED:', err);
  process.exit(1);
});
