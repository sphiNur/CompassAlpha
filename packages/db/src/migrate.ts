/**
 * Migration runner.
 *
 * Order:
 *   1. PRE raw SQL (`migrations/sql/0*.sql`) — schemas, extensions, functions
 *      that drizzle's generated DDL will reference.
 *   2. drizzle generated SQL (creates tables + indexes inside schemas).
 *   3. POST raw SQL (`migrations/sql/9*.sql`) — RLS policies, triggers.
 *
 * All steps are idempotent. Re-running this script after a partial failure
 * is safe (drizzle tracks applied migrations; raw SQL uses IF NOT EXISTS /
 * DROP+CREATE patterns).
 */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsRoot = join(__dirname, '..', 'migrations');
const rawSqlDir = join(migrationsRoot, 'sql');

(function loadRootEnv() {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate) && existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
      for (const raw of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const idx = line.indexOf('=');
        if (idx < 0) continue;
        const key = line.slice(0, idx).trim();
        const val = line
          .slice(idx + 1)
          .trim()
          .replace(/^"(.*)"$/, '$1');
        if (!(key in process.env)) process.env[key] = val;
      }
      return;
    }
    dir = resolve(dir, '..');
  }
})();

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
    await client.unsafe(sqlText);
  }
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
  type JournalEntry = { idx: number; tag: string };
  const journalPath = join(migrationsRoot, 'meta', '_journal.json');
  if (!existsSync(journalPath)) {
    throw new Error(`[migrate] journal not found at ${journalPath}`);
  }
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries?: JournalEntry[];
  };
  const journalTags = new Set((journal.entries ?? []).map((e) => e.tag));

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

async function main() {
  const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }
  const client = postgres(url, { max: 1, prepare: false });
  const db = drizzle(client);

  console.log('[migrate] PRE SQL (extensions, schemas, functions)...');
  await runRawSql(client, (f) => /^0\d/.test(f));

  console.log('[migrate] Checking journal/SQL file consistency...');
  await checkMigrationJournalConsistency();

  console.log('[migrate] Drizzle migrations...');
  await migrate(db, { migrationsFolder: migrationsRoot });

  console.log('[migrate] POST SQL (RLS policies, triggers)...');
  await runRawSql(client, (f) => /^[1-9]/.test(f));

  await client.end({ timeout: 5 });
  console.log('[migrate] Done.');
}

main().catch((err) => {
  console.error('[migrate] FAILED:', err);
  process.exit(1);
});
