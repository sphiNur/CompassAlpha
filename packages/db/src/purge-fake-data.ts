/**
 * HARD-DELETE every piece of fake catalog + procurement data.
 *
 *   bun run packages/db/src/purge-fake-data.ts                # dry-run
 *   bun run packages/db/src/purge-fake-data.ts --apply        # actually wipes
 *
 * What gets wiped (in dep order, single transaction):
 *
 *   read_model.run_item_stores_v        -- delivery splits
 *   read_model.run_items_v              -- run-level item state
 *   read_model.market_runs_v            -- runs themselves
 *   read_model.order_items_v            -- contributor item rows
 *   read_model.order_sessions_v         -- order sessions
 *   domain.snapshots                    -- aggregate snapshots
 *   domain.events                       -- the entire event log
 *   domain.policy_decisions             -- audit trail of allow/deny
 *   inventory.price_history             -- per-purchase observations
 *   inventory.sku_supplier_links        -- preferred-supplier table
 *   inventory.skus                      -- ALL SKUs (including any new ones)
 *   inventory.categories                -- ALL categories
 *   inventory.suppliers                 -- ALL suppliers
 *   inventory.stores                    -- ALL stores
 *   auth.member_store_assignments       -- store bindings (orphaned by stores delete)
 *   sync.outbox                         -- if present
 *   sync.idempotency_keys               -- if present
 *
 * What is PRESERVED:
 *
 *   auth.organizations                  -- the tenant
 *   auth.users                          -- you (owner) + any teammates
 *   auth.members                        -- org membership
 *   auth.roles + role_permissions       -- the 5 built-in roles
 *   auth.permissions                    -- the static dictionary
 *   auth.member_role_bindings           -- so you keep super_admin
 *   auth.policy_rules                   -- ABAC rules (no fake ones exist)
 *   auth.refresh_tokens                 -- so you don't have to re-login
 *   inventory.* schema                  -- empty rows but tables stay
 *
 * After this script you'll have:
 *   - empty catalog (run import-catalog.ts --apply to populate)
 *   - empty stores (create real ones via Admin → Catalog → Stores)
 *   - empty suppliers (create via Admin → Catalog → Suppliers)
 *   - members still bound to org with their roles
 *   - all event history GONE — no audit log of the fake testing period
 *
 * EXTREMELY DESTRUCTIVE. There is no rollback. The dry-run prints exactly
 * how many rows would be touched per table — eyeball that before --apply.
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

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');

// ANSI colors
const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

/**
 * Dependency-ordered wipe list. Each entry: a SQL DELETE that targets
 * the whole table OR a filtered subset (e.g. policy_decisions only for
 * fake actions). The order matters because some tables have FKs that
 * Postgres won't cascade.
 */
const WIPE_PLAN: Array<{ name: string; deleteSql: string; countSql: string }> = [
  // Read-model layer (CASCADE from sessions/runs takes care of children
  // automatically, but we delete leaves first for clarity).
  {
    name: 'read_model.run_item_stores_v',
    deleteSql: 'DELETE FROM read_model.run_item_stores_v',
    countSql: 'SELECT COUNT(*)::int AS n FROM read_model.run_item_stores_v',
  },
  {
    name: 'read_model.run_items_v',
    deleteSql: 'DELETE FROM read_model.run_items_v',
    countSql: 'SELECT COUNT(*)::int AS n FROM read_model.run_items_v',
  },
  {
    name: 'read_model.market_runs_v',
    deleteSql: 'DELETE FROM read_model.market_runs_v',
    countSql: 'SELECT COUNT(*)::int AS n FROM read_model.market_runs_v',
  },
  {
    name: 'read_model.order_items_v',
    deleteSql: 'DELETE FROM read_model.order_items_v',
    countSql: 'SELECT COUNT(*)::int AS n FROM read_model.order_items_v',
  },
  {
    name: 'read_model.order_sessions_v',
    deleteSql: 'DELETE FROM read_model.order_sessions_v',
    countSql: 'SELECT COUNT(*)::int AS n FROM read_model.order_sessions_v',
  },
  // Event log + snapshots
  {
    name: 'domain.snapshots',
    deleteSql: 'DELETE FROM domain.snapshots',
    countSql: 'SELECT COUNT(*)::int AS n FROM domain.snapshots',
  },
  {
    name: 'domain.events',
    deleteSql: 'DELETE FROM domain.events',
    countSql: 'SELECT COUNT(*)::int AS n FROM domain.events',
  },
  {
    name: 'domain.policy_decisions',
    deleteSql: 'DELETE FROM domain.policy_decisions',
    countSql: 'SELECT COUNT(*)::int AS n FROM domain.policy_decisions',
  },
  // Inventory layer
  {
    name: 'inventory.price_history',
    deleteSql: 'DELETE FROM inventory.price_history',
    countSql: 'SELECT COUNT(*)::int AS n FROM inventory.price_history',
  },
  {
    name: 'inventory.sku_supplier_links',
    deleteSql: 'DELETE FROM inventory.sku_supplier_links',
    countSql: 'SELECT COUNT(*)::int AS n FROM inventory.sku_supplier_links',
  },
  {
    name: 'inventory.skus',
    deleteSql: 'DELETE FROM inventory.skus',
    countSql: 'SELECT COUNT(*)::int AS n FROM inventory.skus',
  },
  {
    name: 'inventory.categories',
    deleteSql: 'DELETE FROM inventory.categories',
    countSql: 'SELECT COUNT(*)::int AS n FROM inventory.categories',
  },
  {
    name: 'inventory.suppliers',
    deleteSql: 'DELETE FROM inventory.suppliers',
    countSql: 'SELECT COUNT(*)::int AS n FROM inventory.suppliers',
  },
  // Member-store assignments — manually deleted because there's no FK
  // cascade on the join table (per auth schema).
  {
    name: 'auth.member_store_assignments',
    deleteSql: 'DELETE FROM auth.member_store_assignments',
    countSql: 'SELECT COUNT(*)::int AS n FROM auth.member_store_assignments',
  },
  {
    name: 'inventory.stores',
    deleteSql: 'DELETE FROM inventory.stores',
    countSql: 'SELECT COUNT(*)::int AS n FROM inventory.stores',
  },
  // Reset projector cursor positions so when new events are produced,
  // projectors start from the new beginning. The cursors table doesn't
  // exist if no projectors have run; we silently ignore "table not
  // found" via try-catch.
  {
    name: 'domain.projector_cursors',
    deleteSql: 'DELETE FROM domain.projector_cursors',
    countSql: 'SELECT COUNT(*)::int AS n FROM domain.projector_cursors',
  },
];

async function main() {
  console.log(c.bold(c.red('CompassAlpha — HARD DELETE fake data')));
  console.log(c.dim(`  mode: ${APPLY ? c.red('APPLY (writes!)') : 'DRY-RUN (no writes)'}`));

  const db = getDb();

  // Sanity check: count what's about to die.
  console.log(c.cyan('\n▶ Pre-wipe row counts:'));
  let totalRows = 0;
  for (const step of WIPE_PLAN) {
    let n = 0;
    try {
      const r = await db.execute(sql.raw(step.countSql));
      n = ((r as any)[0]?.n ?? 0) as number;
    } catch (err) {
      console.log(`  ${step.name.padEnd(40)} ${c.dim('(table missing — skip)')}`);
      continue;
    }
    totalRows += n;
    const tag = n > 0 ? c.red(String(n).padStart(6)) : c.dim('     0');
    console.log(`  ${step.name.padEnd(40)} ${tag}`);
  }
  console.log(c.dim(`  ${''.padEnd(40)} ------`));
  console.log(`  ${'TOTAL'.padEnd(40)} ${c.bold(String(totalRows).padStart(6))}`);

  // Sanity check: confirm what's PRESERVED.
  console.log(c.cyan('\n▶ Preserved (these tables are untouched):'));
  const preserved = [
    'auth.organizations',
    'auth.users',
    'auth.members',
    'auth.roles',
    'auth.permissions',
    'auth.role_permissions',
    'auth.member_role_bindings',
    'auth.policy_rules',
    'auth.refresh_tokens',
  ];
  for (const t of preserved) {
    try {
      const r = await db.execute(sql.raw(`SELECT COUNT(*)::int AS n FROM ${t}`));
      const n = ((r as any)[0]?.n ?? 0) as number;
      console.log(`  ${t.padEnd(40)} ${c.green(String(n).padStart(6))}`);
    } catch {
      console.log(`  ${t.padEnd(40)} ${c.dim('(table missing)')}`);
    }
  }

  if (!APPLY) {
    console.log(c.yellow('\nDRY-RUN — no rows deleted.'));
    console.log(c.yellow('Re-run with `--apply` to commit.'));
    await closeDb();
    return;
  }

  // Single transaction so a failure mid-way leaves nothing half-wiped.
  console.log(c.cyan('\n▶ Wiping inside a single transaction…'));
  await db.transaction(async (tx) => {
    for (const step of WIPE_PLAN) {
      try {
        await tx.execute(sql.raw(step.deleteSql));
        console.log(`  ${c.green('✓')} ${step.name}`);
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes('does not exist')) {
          console.log(`  ${c.dim('-')} ${step.name} ${c.dim('(skipped — table missing)')}`);
          continue;
        }
        throw err;
      }
    }
  });

  console.log(c.green(c.bold('\n✔ DONE. All fake catalog + procurement data wiped.')));
  console.log(c.dim('Next: bun run packages/db/src/import-catalog.ts --apply'));
  await closeDb();
}

main().catch((err) => {
  console.error(c.red('FAILED'), err);
  closeDb().finally(() => process.exit(1));
});
