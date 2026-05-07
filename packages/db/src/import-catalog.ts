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
 * Targets the org with `slug='default'` (the only org in v1).
 *
 * SAFETY:
 *   - skuArchive operations are SOFT (sets isArchived=true)
 *   - never deletes price_history rows
 *   - prints a final summary of insert/update/archive counts so you can
 *     sanity-check before exiting
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { eq, and, inArray } from 'drizzle-orm';
import { getDb, closeDb, schema as s } from './index';
import { CATEGORIES, SKUS } from './catalog-uzbek';

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
const ARCHIVE_OLD = args.has('--archive-old');

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
  console.log(c.dim(`  source: packages/db/src/catalog-uzbek.ts`));
  console.log(c.dim(`  cats: ${CATEGORIES.length} · skus: ${SKUS.length}`));

  const db = getDb();

  // --- Find target org ------------------------------------------------------
  const org = await db.query.organizations.findFirst({
    where: (o, { eq: eq2 }) => eq2(o.slug, 'default'),
  });
  if (!org) throw new Error('Default org not found — run seed.ts first');
  const orgId = org.id;
  console.log(c.dim(`  org: ${org.name} (${orgId})`));

  // --- Diff categories ------------------------------------------------------
  step('Categories — diffing against DB');
  const dbCats = await db.query.categories.findMany({
    where: (cat, { eq: eq2 }) => eq2(cat.orgId, orgId),
  });
  const dbCatBySlug = new Map(dbCats.map((c2) => [c2.slug, c2]));
  const newSlugs = new Set(CATEGORIES.map((c2) => c2.slug));

  const catInsert: typeof CATEGORIES = [];
  const catUpdate: typeof CATEGORIES = [];
  const catArchive: typeof dbCats = [];

  for (const want of CATEGORIES) {
    const have = dbCatBySlug.get(want.slug);
    if (!have) {
      catInsert.push(want);
    } else {
      const namesMatch = JSON.stringify(have.names) === JSON.stringify(want.names);
      const sortMatch = have.sortIndex === want.sortIndex;
      const iconMatch = (have.icon ?? null) === (want.icon ?? null);
      const archMatch = have.isArchived === false;
      if (!(namesMatch && sortMatch && iconMatch && archMatch)) {
        catUpdate.push(want);
      }
    }
  }
  if (ARCHIVE_OLD) {
    for (const have of dbCats) {
      if (!newSlugs.has(have.slug as any) && !have.isArchived) {
        catArchive.push(have);
      }
    }
  }
  console.log(`  ${c.green('+')} insert: ${catInsert.length}`);
  console.log(`  ${c.yellow('~')} update: ${catUpdate.length}`);
  console.log(`  ${c.red('-')} archive: ${catArchive.length}`);
  for (const cat of catInsert) console.log(c.dim(`    + ${cat.slug.padEnd(14)} ${cat.names.zh}`));
  for (const cat of catUpdate) console.log(c.dim(`    ~ ${cat.slug.padEnd(14)} ${cat.names.zh}`));
  for (const cat of catArchive) console.log(c.dim(`    - ${cat.slug.padEnd(14)} (was: ${(cat.names as any).zh ?? cat.slug})`));

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
    for (const c2 of catUpdate) {
      await db
        .update(s.categories)
        .set({
          names: c2.names,
          icon: c2.icon ?? null,
          sortIndex: c2.sortIndex,
          isArchived: false,
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
    const namesMatch = JSON.stringify(have.names) === JSON.stringify(want.names);
    const aliasesMatch =
      JSON.stringify((have as any).aliases ?? {}) === JSON.stringify(want.aliases ?? {});
    const descMatch =
      JSON.stringify((have as any).description ?? {}) === JSON.stringify(want.description ?? {});
    const unitMatch = have.unit === want.unit;
    const stepMatch = have.step === want.step;
    const sortMatch = have.sortIndex === want.sortIndex;
    const catMatch = have.categoryId === wantCatId;
    const archMatch = have.isArchived === false;
    if (!(namesMatch && aliasesMatch && descMatch && unitMatch && stepMatch && sortMatch && catMatch && archMatch)) {
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
  console.log(`  ${c.yellow('~')} update: ${skuUpdate.length}`);
  console.log(`  ${c.red('-')} archive: ${skuArchive.length}`);
  // Print per-category summary instead of every single SKU (165 lines is too noisy)
  const insertByCat = new Map<string, number>();
  for (const k of skuInsert) insertByCat.set(k.catSlug, (insertByCat.get(k.catSlug) ?? 0) + 1);
  for (const [cs, n] of insertByCat) console.log(c.dim(`    + ${cs.padEnd(12)} +${n}`));
  for (const k of skuArchive)
    console.log(c.dim(`    - ${(k.code ?? 'no-code').padEnd(20)} ${(k.names as any).en ?? ''}`));

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
    for (const k of skuUpdate) {
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
          isArchived: false,
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
    console.log(c.green('  ✔ APPLIED'));
    console.log(`     categories: +${catInsert.length} ~${catUpdate.length} -${catArchive.length}`);
    console.log(`     skus:       +${skuInsert.length} ~${skuUpdate.length} -${skuArchive.length}`);
    console.log(c.dim(`     (archives are soft — no rows deleted)`));
  } else {
    console.log(c.yellow('  DRY-RUN — nothing was written.'));
    console.log(c.yellow('  Re-run with `--apply` to commit, optionally `--archive-old` to retire stale rows.'));
  }

  await closeDb();
}

main().catch((err) => {
  console.error(c.red('FAILED'), err);
  closeDb().finally(() => process.exit(1));
});
