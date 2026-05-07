/**
 * Quick read-only inventory of what's in the database — used before
 * destructive operations to confirm scope. Does not modify anything.
 */
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
  const tables = [
    'auth.organizations',
    'auth.users',
    'auth.members',
    'auth.role_assignments',
    'auth.store_member_bindings',
    'inventory.stores',
    'inventory.suppliers',
    'inventory.categories',
    'inventory.skus',
    'inventory.sku_supplier_links',
    'inventory.price_history',
    'domain.events',
    'domain.snapshots',
    'domain.policy_decisions',
    'read_model.order_sessions_v',
    'read_model.order_items_v',
    'read_model.market_runs_v',
    'read_model.run_items_v',
    'read_model.run_item_stores_v',
  ];

  console.log('Table                                   Count');
  console.log('--------------------------------------- -----');
  for (const t of tables) {
    try {
      const r = await db.execute(sql.raw(`SELECT COUNT(*)::int AS n FROM ${t}`));
      const n = (r as any)[0]?.n ?? 0;
      console.log(`${t.padEnd(40)} ${String(n).padStart(5)}`);
    } catch (err) {
      console.log(`${t.padEnd(40)} ERROR ${(err as Error).message.slice(0, 60)}`);
    }
  }

  // Show event-stream activity by stream_type
  console.log('\nEvents by stream type:');
  const byStream = await db.execute(
    sql.raw(`SELECT stream_type, COUNT(*)::int AS n FROM domain.events GROUP BY stream_type ORDER BY 1`),
  );
  for (const row of byStream as any[]) {
    console.log(`  ${row.stream_type.padEnd(12)} ${row.n}`);
  }

  // Show stores + suppliers
  console.log('\nStores:');
  const stores = await db.execute(
    sql.raw(`SELECT code, name, is_active FROM inventory.stores ORDER BY sort_index`),
  );
  for (const row of stores as any[]) {
    console.log(`  ${(row.code ?? '-').padEnd(10)} ${row.name}  ${row.is_active ? '' : '[inactive]'}`);
  }

  console.log('\nSuppliers:');
  const suppliers = await db.execute(
    sql.raw(`SELECT name, is_archived FROM inventory.suppliers ORDER BY name`),
  );
  for (const row of suppliers as any[]) {
    console.log(`  ${row.name}  ${row.is_archived ? '[archived]' : ''}`);
  }

  console.log('\nCategories:');
  const cats = await db.execute(
    sql.raw(`SELECT slug, names, is_archived FROM inventory.categories ORDER BY sort_index`),
  );
  for (const row of cats as any[]) {
    console.log(
      `  ${row.slug.padEnd(14)} zh="${row.names?.zh ?? ''}"${row.is_archived ? ' [archived]' : ''}`,
    );
  }

  await closeDb();
}

main().catch((err) => {
  console.error('FAILED', err);
  closeDb().finally(() => process.exit(1));
});
