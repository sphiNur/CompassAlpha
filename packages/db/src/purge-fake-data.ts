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
 *   inventory.store_daily_settlement_revisions -- settlement audit snapshots
 *   inventory.store_daily_settlements   -- daily store closes
 *   inventory.price_history             -- per-purchase observations
 *   inventory.sku_supplier_links        -- preferred-supplier table
 *   inventory.skus                      -- ALL SKUs (including any new ones)
 *   inventory.categories                -- ALL categories
 *   inventory.suppliers                 -- ALL suppliers
 *   inventory.stores                    -- ALL stores
 *   auth.member_store_assignments       -- store bindings (the stores delete
 *                                          cascades them too)
 *   domain.projector_cursors            -- projector positions
 *
 * Deleting stores, SKUs, suppliers and runs also deletes, by ON DELETE
 * CASCADE, everything that hangs off them: stock movements, sales, dish
 * ingredients, run expenses, attendance (punches, shifts, photos, …) and
 * more. The dry-run lists those tables with their row counts too.
 *
 * Refused (DB-05, 2026-11-09):
 *   - while there are daily close revisions: they are kept for good (the
 *     table refuses deletes, as the admin purges do);
 *   - while rows that stay point at rows that go without a cascade (the
 *     delete would fail part way).
 *
 * What is PRESERVED:
 *
 *   auth.organizations                  -- the tenant
 *   auth.users                          -- you (owner) + any teammates
 *   auth.members                        -- org membership
 *   auth.roles + role_permissions       -- built-in roles
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
 * EXTREMELY DESTRUCTIVE. There is no rollback. The dry-run prints how many
 * rows each table would lose, cascades included — eyeball that before
 * --apply.
 *
 * D5 (2026-10-30): `--apply` is refused on production (see purgeGuard.ts)
 * unless COMPASS_ALLOW_BULK_PURGE=true is set for that one command.
 */
import { sql } from 'drizzle-orm';
import { allowEventPurge, getDb, closeDb } from './index';
import { currentWipeRefusal } from './purgeGuard';
import { loadRepoEnv } from './repoEnv';

loadRepoEnv(import.meta.url);

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');

if (APPLY) {
  const refusal = currentWipeRefusal();
  if (refusal) {
    console.error(
      `\x1b[31m✖ Refusing to wipe: this looks like production (${refusal}).\x1b[0m\n` +
        "  This script deletes every tenant's data. If that is really intended,\n" +
        '  take a backup first and re-run with COMPASS_ALLOW_BULK_PURGE=true.',
    );
    process.exit(2);
  }
}

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
    name: 'inventory.store_daily_settlement_revisions',
    deleteSql: 'DELETE FROM inventory.store_daily_settlement_revisions',
    countSql: 'SELECT COUNT(*)::int AS n FROM inventory.store_daily_settlement_revisions',
  },
  {
    name: 'inventory.store_daily_settlements',
    deleteSql: 'DELETE FROM inventory.store_daily_settlements',
    countSql: 'SELECT COUNT(*)::int AS n FROM inventory.store_daily_settlements',
  },
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
  // Member-store assignments: the stores delete below would cascade them
  // too; listed so the counts show them.
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
  // projectors start from the new beginning. A table that does not exist
  // is left out of the plan before anything runs.
  {
    name: 'domain.projector_cursors',
    deleteSql: 'DELETE FROM domain.projector_cursors',
    countSql: 'SELECT COUNT(*)::int AS n FROM domain.projector_cursors',
  },
];

type Db = ReturnType<typeof getDb>;

/** The plan's tables that exist in this database. */
async function presentTables(db: Db, names: readonly string[]): Promise<Set<string>> {
  const present = new Set<string>();
  for (const name of names) {
    const r = await db.execute(sql`SELECT to_regclass(${name}) IS NOT NULL AS ok`);
    if ((r as unknown as Array<{ ok: boolean }>)[0]?.ok) present.add(name);
  }
  return present;
}

/** A foreign key: `child.col` points at `parent`; `onDelete` as in pg_constraint. */
type Fk = { child: string; parent: string; col: string; onDelete: string };

async function foreignKeys(db: Db): Promise<Fk[]> {
  const rows = await db.execute(sql`
    SELECT con.conrelid::regclass::text AS child,
           con.confrelid::regclass::text AS parent,
           att.attname AS col,
           con.confdeltype AS "onDelete"
      FROM pg_constraint con
      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
     WHERE con.contype = 'f'`);
  return rows as unknown as Fk[];
}

/**
 * DB-05: what deleting `wiped` takes with it (ON DELETE CASCADE, followed
 * down), and the keys from rows that stay that would stop it (NO ACTION,
 * RESTRICT).
 */
function reach(fks: readonly Fk[], wiped: ReadonlySet<string>) {
  const cascaded = new Map<string, Fk>();
  const queue = [...wiped];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const fk of fks) {
      if (fk.parent !== parent || fk.onDelete !== 'c') continue;
      if (wiped.has(fk.child) || cascaded.has(fk.child)) continue;
      cascaded.set(fk.child, fk);
      queue.push(fk.child);
    }
  }
  const gone = new Set([...wiped, ...cascaded.keys()]);
  const blocking = fks.filter(
    (fk) =>
      gone.has(fk.parent) && !gone.has(fk.child) && (fk.onDelete === 'a' || fk.onDelete === 'r'),
  );
  return { cascaded: [...cascaded.values()], blocking };
}

/**
 * Rows of `fk.child` that point somewhere through `fk.col`. Every table in
 * the plan is emptied, so while the keys the cascade follows are NOT NULL
 * (all of them are today) that is every row of the table and the count is
 * exact; through a nullable key it would only be an estimate.
 */
async function pointingRows(db: Db, fk: Fk): Promise<number> {
  const [schema, table] = fk.child.split('.') as [string, string];
  const r = await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM ${sql.identifier(schema)}.${sql.identifier(table)}
        WHERE ${sql.identifier(fk.col)} IS NOT NULL`,
  );
  return (r as unknown as Array<{ n: number }>)[0]?.n ?? 0;
}

async function main() {
  console.log(c.bold(c.red('CompassAlpha — HARD DELETE fake data')));
  console.log(c.dim(`  mode: ${APPLY ? c.red('APPLY (writes!)') : 'DRY-RUN (no writes)'}`));

  const db = getDb(undefined, { system: 'maintenance' });

  // Everything is looked at before anything is written: inside the
  // transaction a failed statement aborts the rest, so a missing table
  // cannot be skipped there.
  const present = await presentTables(
    db,
    WIPE_PLAN.map((step) => step.name),
  );
  const plan = WIPE_PLAN.filter((step) => present.has(step.name));

  // Sanity check: count what's about to die.
  console.log(c.cyan('\n▶ Pre-wipe row counts:'));
  let totalRows = 0;
  const counts = new Map<string, number>();
  for (const step of WIPE_PLAN) {
    if (!present.has(step.name)) {
      console.log(`  ${step.name.padEnd(40)} ${c.dim('(table missing — skip)')}`);
      continue;
    }
    const r = await db.execute<{ n: number }>(sql.raw(step.countSql));
    const n = r[0]?.n ?? 0;
    counts.set(step.name, n);
    totalRows += n;
    const tag = n > 0 ? c.red(String(n).padStart(6)) : c.dim('     0');
    console.log(`  ${step.name.padEnd(40)} ${tag}`);
  }

  const { cascaded, blocking } = reach(await foreignKeys(db), present);
  console.log(c.cyan('\n▶ Also deleted with them (ON DELETE CASCADE):'));
  for (const fk of cascaded) {
    const n = await pointingRows(db, fk);
    totalRows += n;
    const tag = n > 0 ? c.red(String(n).padStart(6)) : c.dim('     0');
    console.log(`  ${fk.child.padEnd(40)} ${tag} ${c.dim(`via ${fk.col} → ${fk.parent}`)}`);
  }
  console.log(c.dim(`  ${''.padEnd(40)} ------`));
  console.log(`  ${'TOTAL'.padEnd(40)} ${c.bold(String(totalRows).padStart(6))}`);

  const refusals: string[] = [];
  const revisions = counts.get('inventory.store_daily_settlement_revisions') ?? 0;
  if (revisions > 0) {
    refusals.push(
      `${revisions} daily close revisions: they are kept for good and the table refuses ` +
        'deletes (the admin purges refuse the same way).',
    );
  }
  for (const fk of blocking) {
    const n = await pointingRows(db, fk);
    if (n > 0) {
      refusals.push(
        `${n} rows of ${fk.child} stay and point at ${fk.parent} (${fk.col}): the delete would fail.`,
      );
    }
  }

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
      const r = await db.execute<{ n: number }>(sql.raw(`SELECT COUNT(*)::int AS n FROM ${t}`));
      const n = r[0]?.n ?? 0;
      console.log(`  ${t.padEnd(40)} ${c.green(String(n).padStart(6))}`);
    } catch {
      console.log(`  ${t.padEnd(40)} ${c.dim('(table missing)')}`);
    }
  }

  if (refusals.length > 0) {
    console.log(c.red(`\n✖ ${APPLY ? 'Refusing to wipe' : 'An --apply would be refused'}:`));
    for (const why of refusals) console.log(c.red(`  - ${why}`));
    if (APPLY) {
      await closeDb();
      process.exit(2);
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
    // domain.events refuses deletes unless the transaction says it is a
    // purge (migration 0055).
    await allowEventPurge(tx);
    for (const step of plan) {
      await tx.execute(sql.raw(step.deleteSql));
      console.log(`  ${c.green('✓')} ${step.name}`);
    }
  });

  console.log(c.green(c.bold('\n✔ DONE. All fake catalog + procurement data wiped.')));
  console.log(c.dim('Next: bun run packages/db/src/import-catalog.ts --apply'));
  await closeDb();
}

main().catch((err) => {
  console.error(c.red('FAILED'), err);
  void closeDb().finally(() => process.exit(1));
});
