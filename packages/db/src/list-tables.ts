/** List every table grouped by schema. Read-only. */
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
  const r = await db.execute(
    sql.raw(`SELECT schemaname, tablename FROM pg_tables
             WHERE schemaname NOT IN ('pg_catalog','information_schema','public')
             ORDER BY schemaname, tablename`),
  );
  for (const row of r as any[]) {
    console.log(`${row.schemaname}.${row.tablename}`);
  }
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  closeDb().finally(() => process.exit(1));
});
