import { sql } from 'drizzle-orm';
import { getDb, closeDb } from './index';
import { loadRepoEnv } from './repoEnv';

loadRepoEnv(import.meta.url);

async function main() {
  const db = getDb(undefined, { system: 'maintenance' });
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
