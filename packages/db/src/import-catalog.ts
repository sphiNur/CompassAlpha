/**
 * One-shot real-catalog importer for an Uzbek-market restaurant chain.
 *
 *   bun run packages/db/src/import-catalog.ts             # dry-run, prints diff
 *   bun run packages/db/src/import-catalog.ts --apply    # actually writes
 *   bun run packages/db/src/import-catalog.ts --apply --archive-old
 *                                                        # also archive every
 *                                                        # SKU/category whose
 *                                                        # code/slug isn't in
 *                                                        # the new catalog
 *   bun run packages/db/src/import-catalog.ts --apply --update-existing
 *                                                        # also overwrite rows
 *                                                        # that differ from it
 *
 * Lives under packages/db/src so it picks up the package's drizzle-orm
 * dependency (the root scripts/ folder has no node_modules).
 *
 * Why a script (vs the existing seed.ts):
 *   - seed.ts is fresh-database-only and would deadlock on the existing
 *     fake catalog rows in production
 *   - we want a dry-run preview with a colored diff before touching prod
 *   - we want to archive (NOT delete) the fake rows so any historic
 *     fake orders/runs that referenced them still resolve
 *
 * Idempotent. Re-runs after a successful apply do nothing (no inserts,
 * no updates) unless catalog-uzbek.ts has changed.
 *
 * DB-04 (2026-11-09): rows already there are the tenant's. By default only
 * missing rows are added; rows that differ are listed, and overwritten only
 * with --update-existing. An update never un-archives a row an admin
 * archived. Steps compare as numbers ('1.000' from the database is '1')
 * and names as JSON with sorted keys (jsonb reorders them), so a re-run
 * finds nothing to do. --apply writes in one transaction.
 *
 * Targets the org with `slug='default'` (the only org in v1).
 *
 * SAFETY:
 *   - skuArchive operations are SOFT (sets isArchived=true)
 *   - never deletes price_history rows
 *   - prints a final summary of insert/update/archive counts so you can
 *     sanity-check before exiting
 */
import { eq, and, inArray } from 'drizzle-orm';
import { getDb, closeDb, schema as s } from './index';
import { printable } from './printable';
import { CATEGORIES, SKUS } from './catalog-uzbek';
import { loadRepoEnv } from './repoEnv';

loadRepoEnv(import.meta.url);

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const ARCHIVE_OLD = args.has('--archive-old');
const UPDATE_EXISTING = args.has('--update-existing');

/** JSON with object keys sorted, so two jsonb values compare by content. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}
const sameJson = (a: unknown, b: unknown) => canonical(a ?? {}) === canonical(b ?? {});

// --- ANSI colors (zero deps) -------------------------------------------------
const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function step(label: string) {
  console.log(`\n${c.cyan('▶')} ${c.bold(label)}`);
}

async function main() {
  console.log(c.bold('CompassAlpha — real-catalog import'));
  console.log(c.dim(`  mode: ${APPLY ? 'APPLY' : 'DRY-RUN (no writes)'}`));
  console.log(c.dim(`  archive-old: ${ARCHIVE_OLD ? 'yes' : 'no'}`));
  console.log(c.dim(`  update-existing: ${UPDATE_EXISTING ? 'yes' : 'no'}`));
  console.log(c.dim(`  source: packages/db/src/catalog-uzbek.ts`));
  console.log(c.dim(`  cats: ${CATEGORIES.length} · skus: ${SKUS.length}`));

  const db = getDb(undefined, { system: 'maintenance' });

  // --- Find target org ------------------------------------------------------
  const org = await db.query.organizations.findFirst({
    where: (o, { eq: eq2 }) => eq2(o.slug, 'default'),
  });
  if (!org) throw new Error('Default org not found — run seed.ts first');
  const orgId = org.id;
  console.log(c.dim(`  org: ${printable(org.name)} (${orgId})`));

  // One transaction: a failure part way leaves the catalog as it was. A
  // dry run only reads.
  await db.transaction((tx) => importInto(tx, orgId));
  await closeDb();
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

async function importInto(db: Tx, orgId: string) {
  // --- Diff categories ------------------------------------------------------
  step('Categories — diffing against DB');
  const dbCats = await db.query.categories.findMany({
    where: (cat, { eq: eq2 }) => eq2(cat.orgId, orgId),
  });
  const dbCatBySlug = new Map(dbCats.map((c2) => [c2.slug, c2]));
  const newSlugs = new Set<string>(CATEGORIES.map((c2) => c2.slug));

  const catInsert: typeof CATEGORIES = [];
  const catUpdate: typeof CATEGORIES = [];
  const catArchive: typeof dbCats = [];

  for (const want of CATEGORIES) {
    const have = dbCatBySlug.get(want.slug);
    if (!have) {
      catInsert.push(want);
    } else {
      const namesMatch = sameJson(have.names, want.names);
      const sortMatch = have.sortIndex === want.sortIndex;
      const iconMatch = (have.icon ?? null) === (want.icon ?? null);
      if (!(namesMatch && sortMatch && iconMatch)) {
        catUpdate.push(want);
      }
    }
  }
  if (ARCHIVE_OLD) {
    for (const have of dbCats) {
      if (!newSlugs.has(have.slug) && !have.isArchived) {
        catArchive.push(have);
      }
    }
  }
  console.log(`  ${c.green('+')} insert: ${catInsert.length}`);
  console.log(
    `  ${c.yellow('~')} ${UPDATE_EXISTING ? 'update' : 'differ (kept)'}: ${catUpdate.length}`,
  );
  console.log(`  ${c.red('-')} archive: ${catArchive.length}`);
  for (const cat of catInsert) console.log(c.dim(`    + ${cat.slug.padEnd(14)} ${cat.names.zh}`));
  for (const cat of catUpdate) console.log(c.dim(`    ~ ${cat.slug.padEnd(14)} ${cat.names.zh}`));
  for (const cat of catArchive) console.log(c.dim(`    - ${printable(cat.slug).padEnd(14)} (was: ${printable((cat.names as { zh?: string }).zh ?? cat.slug)})`));

  // --- Apply categories -----------------------------------------------------
  if (APPLY) {
    if (catInsert.length > 0) {
      await db.insert(s.categories).values(
        catInsert.map((c2) => ({
          orgId,
          slug: c2.slug,
          names: c2.names,
          icon: c2.icon ?? null,
          sortIndex: c2.sortIndex,
        })),
      );
    }
    for (const c2 of UPDATE_EXISTING ? catUpdate : []) {
      await db
        .update(s.categories)
        .set({
          names: c2.names,
          icon: c2.icon ?? null,
          sortIndex: c2.sortIndex,
          updatedAt: new Date(),
        })
        .where(and(eq(s.categories.orgId, orgId), eq(s.categories.slug, c2.slug)));
    }
    if (catArchive.length > 0) {
      await db
        .update(s.categories)
        .set({ isArchived: true, updatedAt: new Date() })
        .where(
          and(
            eq(s.categories.orgId, orgId),
            inArray(s.categories.id, catArchive.map((c2) => c2.id)),
          ),
        );
    }
  }

  // --- Re-fetch categories so we have IDs for the SKU pass -----------------
  const cats2 = await db.query.categories.findMany({
    where: (cat, { eq: eq2 }) => eq2(cat.orgId, orgId),
  });
  const catIdBySlug = new Map(cats2.map((c2) => [c2.slug, c2.id]));

  // --- Diff SKUs ------------------------------------------------------------
  step('SKUs — diffing against DB');
  const dbSkus = await db.query.skus.findMany({
    where: (k, { eq: eq2 }) => eq2(k.orgId, orgId),
  });
  const dbSkuByCode = new Map(
    dbSkus.filter((k) => !!k.code).map((k) => [k.code as string, k]),
  );
  const newCodes = new Set(SKUS.map((k) => k.code));

  const skuInsert: typeof SKUS = [];
  const skuUpdate: typeof SKUS = [];
  const skuArchive: typeof dbSkus = [];

  for (const want of SKUS) {
    const have = dbSkuByCode.get(want.code);
    if (!have) {
      skuInsert.push(want);
      continue;
    }
    const wantCatId = catIdBySlug.get(want.catSlug) ?? null;
    const namesMatch = sameJson(have.names, want.names);
    const aliasesMatch = sameJson(have.aliases, want.aliases);
    const descMatch = sameJson(have.description, want.description);
    const unitMatch = have.unit === want.unit;
    const stepMatch = Number(have.step) === Number(want.step);
    const sortMatch = have.sortIndex === want.sortIndex;
    const catMatch = have.categoryId === wantCatId;
    if (
      !(namesMatch && aliasesMatch && descMatch && unitMatch && stepMatch && sortMatch && catMatch)
    ) {
      skuUpdate.push(want);
    }
  }
  if (ARCHIVE_OLD) {
    for (const have of dbSkus) {
      if (have.code && !newCodes.has(have.code) && !have.isArchived) {
        skuArchive.push(have);
      }
    }
  }
  console.log(`  ${c.green('+')} insert: ${skuInsert.length}`);
  console.log(
    `  ${c.yellow('~')} ${UPDATE_EXISTING ? 'update' : 'differ (kept)'}: ${skuUpdate.length}`,
  );
  console.log(`  ${c.red('-')} archive: ${skuArchive.length}`);
  // Print per-category summary instead of every single SKU (165 lines is too noisy)
  const insertByCat = new Map<string, number>();
  for (const k of skuInsert) insertByCat.set(k.catSlug, (insertByCat.get(k.catSlug) ?? 0) + 1);
  for (const [cs, n] of insertByCat) console.log(c.dim(`    + ${cs.padEnd(12)} +${n}`));
  for (const k of skuArchive)
    console.log(
      c.dim(
        `    - ${printable(k.code ?? 'no-code').padEnd(20)} ${printable((k.names as { en?: string }).en)}`,
      ),
    );

  // --- Apply SKUs -----------------------------------------------------------
  if (APPLY) {
    if (skuInsert.length > 0) {
      await db.insert(s.skus).values(
        skuInsert.map((k) => ({
          orgId,
          categoryId: catIdBySlug.get(k.catSlug) ?? null,
          code: k.code,
          names: k.names,
          aliases: k.aliases ?? {},
          description: k.description ?? {},
          unit: k.unit,
          step: k.step,
          sortIndex: k.sortIndex,
        })),
      );
    }
    for (const k of UPDATE_EXISTING ? skuUpdate : []) {
      await db
        .update(s.skus)
        .set({
          categoryId: catIdBySlug.get(k.catSlug) ?? null,
          names: k.names,
          aliases: k.aliases ?? {},
          description: k.description ?? {},
          unit: k.unit,
          step: k.step,
          sortIndex: k.sortIndex,
          updatedAt: new Date(),
        })
        .where(and(eq(s.skus.orgId, orgId), eq(s.skus.code, k.code)));
    }
    if (skuArchive.length > 0) {
      await db
        .update(s.skus)
        .set({ isArchived: true, updatedAt: new Date() })
        .where(
          and(
            eq(s.skus.orgId, orgId),
            inArray(s.skus.id, skuArchive.map((k) => k.id)),
          ),
        );
    }
  }

  // --- Summary --------------------------------------------------------------
  step('Summary');
  if (APPLY) {
    const catUpdated = UPDATE_EXISTING ? catUpdate.length : 0;
    const skuUpdated = UPDATE_EXISTING ? skuUpdate.length : 0;
    console.log(c.green('  ✔ APPLIED'));
    console.log(`     categories: +${catInsert.length} ~${catUpdated} -${catArchive.length}`);
    console.log(`     skus:       +${skuInsert.length} ~${skuUpdated} -${skuArchive.length}`);
    console.log(c.dim(`     (archives are soft — no rows deleted)`));
  } else {
    console.log(c.yellow('  DRY-RUN — nothing was written.'));
    console.log(
      c.yellow(
        '  Re-run with `--apply` to commit, optionally `--archive-old` to retire stale rows' +
          ' and `--update-existing` to overwrite rows that differ.',
      ),
    );
  }
}

main().catch((err) => {
  console.error(c.red('FAILED'), err);
  void closeDb().finally(() => process.exit(1));
});
