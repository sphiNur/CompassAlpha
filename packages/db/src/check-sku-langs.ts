/** Check whether the imported SKUs actually have all 4 languages. */
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
  console.log('Sample SKU rows (first 5):');
  const r = await db.execute(
    sql.raw(`SELECT code, names FROM inventory.skus ORDER BY sort_index LIMIT 5`),
  );
  for (const row of r as any[]) {
    console.log(`  ${row.code}`);
    console.log(`    names: ${JSON.stringify(row.names)}`);
    const langs = Object.keys(row.names ?? {});
    console.log(`    langs: ${langs.join(',')} (${langs.length})`);
  }

  console.log('\nLanguage coverage across ALL skus:');
  const r2 = await db.execute(
    sql.raw(`
      SELECT
        COUNT(*) FILTER (WHERE names ? 'zh')::int AS zh,
        COUNT(*) FILTER (WHERE names ? 'en')::int AS en,
        COUNT(*) FILTER (WHERE names ? 'ru')::int AS ru,
        COUNT(*) FILTER (WHERE names ? 'uz')::int AS uz,
        COUNT(*)::int AS total
      FROM inventory.skus
    `),
  );
  console.log(`  ${JSON.stringify((r2 as any)[0])}`);

  console.log('\nCategory coverage:');
  const r3 = await db.execute(
    sql.raw(`
      SELECT
        COUNT(*) FILTER (WHERE names ? 'zh')::int AS zh,
        COUNT(*) FILTER (WHERE names ? 'en')::int AS en,
        COUNT(*) FILTER (WHERE names ? 'ru')::int AS ru,
        COUNT(*) FILTER (WHERE names ? 'uz')::int AS uz,
        COUNT(*)::int AS total
      FROM inventory.categories
    `),
  );
  console.log(`  ${JSON.stringify((r3 as any)[0])}`);

  await closeDb();
}

main().catch((e) => {
  console.error(e);
  closeDb().finally(() => process.exit(1));
});
