/** List every table grouped by schema. Read-only. */
import { sql } from 'drizzle-orm';
import { getDb, closeDb } from './index';
import { loadRepoEnv } from './repoEnv';

loadRepoEnv(import.meta.url);

async function main() {
  const db = getDb(undefined, { system: 'maintenance' });
  const r = await db.execute<{ schemaname: string; tablename: string }>(
    sql.raw(`SELECT schemaname, tablename FROM pg_tables
             WHERE schemaname NOT IN ('pg_catalog','information_schema','public')
             ORDER BY schemaname, tablename`),
  );
  for (const row of r) {
    console.log(`${row.schemaname}.${row.tablename}`);
  }
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  void closeDb().finally(() => process.exit(1));
});
