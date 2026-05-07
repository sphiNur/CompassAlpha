import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { getDb, closeDb } from './index';

(function loadRootEnv() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate) && existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
      for (const raw of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const idx = line.indexOf('=');
        if (idx < 0) continue;
        const key = line.slice(0, idx).trim();
        const val = line.slice(idx + 1).trim().replace(/^"(.*)"$/, '$1');
        if (!(key in process.env)) process.env[key] = val;
      }
      return;
    }
    dir = resolve(dir, '..');
  }
})();

async function main() {
  const db = getDb();
  console.log('All schemas:');
  const schemas = await db.execute(sql.raw(`
    SELECT schemaname, tablename FROM pg_tables
    WHERE schemaname NOT IN ('pg_catalog','information_schema','public')
    ORDER BY 1, 2
  `));
  for (const row of schemas as any[]) {
    console.log(`  ${row.schemaname}.${row.tablename}`);
  }

  // Find any outbox-like table
  console.log('\nLooking for outbox-like tables:');
  const outboxes = await db.execute(sql.raw(`
    SELECT schemaname, tablename FROM pg_tables
    WHERE tablename ILIKE '%outbox%' OR tablename ILIKE '%notify%'
  `));
  for (const row of outboxes as any[]) {
    console.log(`  ${row.schemaname}.${row.tablename}`);
    const cols = await db.execute(
      sql.raw(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = '${row.schemaname}' AND table_name = '${row.tablename}'`),
    );
    for (const c of cols as any[]) console.log(`    - ${c.column_name} (${c.data_type})`);

    // Show recent rows
    const rows = await db.execute(
      sql.raw(`SELECT * FROM ${row.schemaname}.${row.tablename} ORDER BY 1 DESC LIMIT 5`),
    );
    for (const r of rows as any[]) console.log(`    row: ${JSON.stringify(r).slice(0, 300)}`);
  }
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  closeDb().finally(() => process.exit(1));
});
