/**
 * Copy one organisation's catalog into another (operator tool).
 *
 *   bun apps/api/scripts/copy-catalog.ts --list
 *   bun apps/api/scripts/copy-catalog.ts --from <org id|slug> --to <org id|slug> [--suppliers]
 *   bun apps/api/scripts/copy-catalog.ts --from ... --to ... [--suppliers] --apply
 *
 * Without --apply it only prints what would be created. What is copied
 * and what is not: src/services/catalogCopy.ts. Admins can do the same
 * from the app (Catalog → Import from another organisation).
 *
 * The source is read in a transaction bound to the source org and the
 * target written in one bound to the target org, so tenant isolation
 * stays on for the copy itself; only --list and resolving slugs read
 * across organisations.
 */
import { closeDb, getDb, schema as s, withOrgContext, withSystemContext } from '@compass/db';
import { applyCatalogCopy, readCatalogSnapshot } from '../src/services/catalogCopy';

function arg(name: string): string | null {
  const at = process.argv.indexOf(name);
  if (at === -1) return null;
  const value = process.argv[at + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

async function main(): Promise<void> {
  const db = getDb(process.env.DATABASE_URL);
  const orgs = await withSystemContext(db, 'maintenance', (tx) =>
    tx
      .select({ id: s.organizations.id, slug: s.organizations.slug, name: s.organizations.name })
      .from(s.organizations),
  );

  if (process.argv.includes('--list')) {
    for (const o of orgs) console.log(`${o.id}  ${o.slug}  ${o.name}`);
    return;
  }

  const find = (key: string | null, flag: string) => {
    if (!key) throw new Error(`${flag} is required (see --list)`);
    const org = orgs.find((o) => o.id === key || o.slug === key);
    if (!org) throw new Error(`${flag}: no organisation "${key}" (see --list)`);
    return org;
  };
  const from = find(arg('--from'), '--from');
  const to = find(arg('--to'), '--to');
  if (from.id === to.id) throw new Error('--from and --to are the same organisation');
  const includeSuppliers = process.argv.includes('--suppliers');
  const apply = process.argv.includes('--apply');

  const source = await withOrgContext(db, from.id, (tx) => readCatalogSnapshot(tx, from.id));
  const summary = await withOrgContext(db, to.id, (tx) =>
    applyCatalogCopy(tx, to.id, source, { includeSuppliers, dryRun: !apply }),
  );

  console.log(`${apply ? 'Copied' : 'Would copy'}: ${from.name} → ${to.name}`);
  console.log(
    `  categories  new ${summary.categories.created}, already there ${summary.categories.existing}`,
  );
  if (includeSuppliers) {
    console.log(
      `  suppliers   new ${summary.suppliers.created}, already there ${summary.suppliers.existing}`,
    );
  }
  console.log(`  products    new ${summary.skus.created}, already there ${summary.skus.existing}`);
  if (includeSuppliers) console.log(`  product–supplier links  ${summary.links.created}`);
  if (!apply) console.log('\nNothing written. Re-run with --apply to copy.');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
