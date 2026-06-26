/**
 * Audit and optionally normalize production SKU category assignments.
 *
 *   bun run packages/db/src/audit-sku-catalog.ts
 *   bun run packages/db/src/audit-sku-catalog.ts --apply
 *
 * Default mode is read-only. `--apply` only updates `inventory.skus.category_id`
 * for active SKUs whose category is missing or archived. It does not rewrite
 * names/translations because production operators said zh/uz are reliable while
 * other languages may be random; guessing translations would be more dangerous
 * than reporting suspicious rows.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, schema as s } from './index';

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
        const val = line
          .slice(idx + 1)
          .trim()
          .replace(/^"(.*)"$/, '$1');
        if (!(key in process.env)) process.env[key] = val;
      }
      return;
    }
    dir = resolve(dir, '..');
  }
})();

const APPLY = process.argv.includes('--apply');

type Names = Record<string, string | undefined>;
type CategorySlug =
  | 'produce'
  | 'meat'
  | 'dairy'
  | 'dry-goods'
  | 'bakery'
  | 'packaging'
  | 'cleaning';

const RULES: Array<{ slug: CategorySlug; terms: RegExp[] }> = [
  {
    slug: 'cleaning',
    terms: [
      /clean|detergent|soap|sponge|bleach|tozal|sovun|gubka|moika|salfe/i,
      /清洁|洗|皂|海绵|垃圾袋|消毒/,
    ],
  },
  {
    slug: 'packaging',
    terms: [
      /paper|napkin|box|cup|bag|straw|foil|match|gugurt|qog|paket|karob|sal/i,
      /纸|包装|盒|杯|袋|吸管|锡纸|火柴|餐巾/,
    ],
  },
  {
    slug: 'dairy',
    terms: [
      /sut|qatiq|yogurt|suzma|sir|pishloq|sariyog|slivka|cream|cheese|milk|butter|tvorog/i,
      /奶|酸奶|黄油|奶酪|乳|芝士/,
    ],
  },
  {
    slug: 'meat',
    terms: [
      /tovuq|mol|qo'?y|gosht|go'sht|qanot|bedro|file|suyak|kolbasa|sasiska|tuxum|qazi|dumba|indeyka/i,
      /鸡|牛|羊|肉|骨|蛋|香肠|马肉/,
    ],
  },
  {
    slug: 'produce',
    terms: [
      /sabzi|piyoz|kartosh|pomidor|bodring|baklajan|bolgar|karom|daykon|limon|apelsin|shaptul|uruk|tarwuz|yalpiz|seldr|kivi|meva|sabzavot/i,
      /菜|萝卜|土豆|番茄|西红柿|黄瓜|茄|椒|葱|蒜|姜|橙|柠檬|桃|杏|西瓜|水果|猕猴桃|芹菜|薄荷/,
    ],
  },
  {
    slug: 'bakery',
    terms: [
      /xamir|non|lavash|bread|dough|lag'?mon|narin|buxanka|turan un/i,
      /面皮|拉面|馕|面包|面点|馄饨|混沌/,
    ],
  },
  {
    slug: 'dry-goods',
    terms: [
      /un|yog|kraxmal|tuz|ziravor|murch|choy|tea|kunjut|sous|sauce|konserv|konsir|rolton|makaron|guruch|novot|shakar|vanil/i,
      /粉|油|盐|调味|茶|芝麻|酱|罐头|面粉|淀粉|糖|饼干|方便面|米/,
    ],
  },
];

function normalize(v: string | null | undefined): string {
  return (v ?? '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

function displayName(names: Names): string {
  return names.zh || names.uz || names.en || names.ru || '-';
}

function suggestCategory(names: Names, unit: string | null): CategorySlug | null {
  const text = [names.zh, names.uz, names.en, names.ru, unit].map(normalize).join(' ');
  const hits = RULES.map((rule) => ({
    slug: rule.slug,
    score: rule.terms.reduce((sum, re) => sum + (re.test(text) ? 1 : 0), 0),
  })).filter((r) => r.score > 0);
  hits.sort((a, b) => b.score - a.score);
  if (hits.length === 0) return null;
  if (hits.length > 1 && hits[0]!.score === hits[1]!.score) return null;
  return hits[0]!.slug;
}

function suspiciousLanguageNotes(names: Names): string[] {
  const notes: string[] = [];
  const zh = normalize(names.zh);
  const uz = normalize(names.uz);
  for (const locale of ['en', 'ru'] as const) {
    const v = normalize(names[locale]);
    if (!v) {
      notes.push(`${locale}:missing`);
      continue;
    }
    if (v === zh || v === uz) notes.push(`${locale}:copied`);
    if (locale === 'ru' && v && !/\p{Script=Cyrillic}/u.test(v)) notes.push('ru:not-cyrillic');
    if (locale === 'en' && /[\p{Script=Han}\p{Script=Cyrillic}]/u.test(v))
      notes.push('en:not-latin');
  }
  return notes;
}

async function main() {
  const db = getDb();
  const org = await db.query.organizations.findFirst({
    where: (o, { eq: eq2 }) => eq2(o.slug, 'default'),
  });
  if (!org) throw new Error('Default org not found');

  const categories = await db.query.categories.findMany({
    where: (cat, { eq: eq2 }) => eq2(cat.orgId, org.id),
  });
  const catById = new Map(categories.map((cat) => [cat.id, cat]));
  const catBySlug = new Map(categories.map((cat) => [cat.slug, cat]));
  const skus = await db.query.skus.findMany({
    where: (sku, { eq: eq2 }) => eq2(sku.orgId, org.id),
  });

  const activeSkus = skus.filter((sku) => !sku.isArchived);
  const categoryUpdates: Array<{
    id: string;
    code: string | null;
    name: string;
    from: string;
    to: CategorySlug;
  }> = [];
  const languageWarnings: Array<{
    id: string;
    code: string | null;
    name: string;
    notes: string[];
  }> = [];
  const noSuggestion: Array<{ id: string; code: string | null; name: string }> = [];

  for (const sku of activeSkus) {
    const names = (sku.names ?? {}) as Names;
    const current = sku.categoryId ? catById.get(sku.categoryId) : null;
    const needsCategory = !current || current.isArchived;
    const suggested = suggestCategory(names, sku.unit ?? null);
    if (
      needsCategory &&
      suggested &&
      catBySlug.get(suggested) &&
      !catBySlug.get(suggested)!.isArchived
    ) {
      categoryUpdates.push({
        id: sku.id,
        code: sku.code,
        name: displayName(names),
        from: current?.slug ?? '(none)',
        to: suggested,
      });
    } else if (needsCategory) {
      noSuggestion.push({ id: sku.id, code: sku.code, name: displayName(names) });
    }

    const notes = suspiciousLanguageNotes(names);
    if (notes.length > 0) {
      languageWarnings.push({ id: sku.id, code: sku.code, name: displayName(names), notes });
    }
  }

  console.log(`CompassAlpha SKU catalog audit (${APPLY ? 'APPLY' : 'DRY-RUN'})`);
  console.log(`org=${org.name} activeSkus=${activeSkus.length} categories=${categories.length}`);
  console.log(`category updates suggested=${categoryUpdates.length}`);
  for (const row of categoryUpdates) {
    console.log(`  ~ ${row.name} [${row.code ?? row.id.slice(0, 8)}] ${row.from} -> ${row.to}`);
  }
  console.log(`no category suggestion=${noSuggestion.length}`);
  for (const row of noSuggestion.slice(0, 30)) {
    console.log(`  ? ${row.name} [${row.code ?? row.id.slice(0, 8)}]`);
  }
  console.log(`language warnings=${languageWarnings.length}`);
  for (const row of languageWarnings.slice(0, 60)) {
    console.log(`  ! ${row.name} [${row.code ?? row.id.slice(0, 8)}] ${row.notes.join(',')}`);
  }

  if (APPLY) {
    for (const row of categoryUpdates) {
      const cat = catBySlug.get(row.to);
      if (!cat) continue;
      await db
        .update(s.skus)
        .set({ categoryId: cat.id, updatedAt: new Date() })
        .where(eq(s.skus.id, row.id));
    }
    console.log(`applied category updates=${categoryUpdates.length}`);
  } else {
    console.log('dry-run only. Re-run with --apply to write category_id updates.');
  }

  await closeDb();
}

main().catch((err) => {
  console.error(err);
  closeDb().finally(() => process.exit(1));
});
