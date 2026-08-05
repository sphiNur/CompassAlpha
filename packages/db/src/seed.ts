/**
 * Seed for local development. Idempotent: re-running won't duplicate.
 *
 * Creates:
 *   - default-org organization
 *   - permissions catalog (full PERMISSIONS list)
 *   - 5 built-in roles (super_admin, admin, manager, purchaser, staff)
 *   - 2 stores (Kitchen, Hotel)
 *   - 3 suppliers
 *   - 6 categories (i18n)
 *   - 18 SKUs (i18n)
 */
import { sql } from 'drizzle-orm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { getDb, closeDb, schema as s } from './index';
import { PERMISSIONS, BUILTIN_ROLES } from './seed-data';

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

async function main() {
  const db = getDb();
  console.log('[seed] Permissions catalog...');
  await db
    .insert(s.permissions)
    .values(PERMISSIONS.map((p) => ({ key: p.key, description: p.description })))
    .onConflictDoNothing();

  console.log('[seed] Default organization...');
  const [org] = await db
    .insert(s.organizations)
    .values({
      slug: 'default',
      name: 'Default Organization',
      localeDefault: 'en',
      timezone: 'Asia/Tashkent',
      workflow: { steps: ['draft', 'submitted', 'approved', 'in_run', 'delivered', 'confirmed'] },
    })
    .onConflictDoNothing({ target: s.organizations.slug })
    .returning();

  const orgRow =
    org ??
    (await db.query.organizations.findFirst({ where: (x, { eq }) => eq(x.slug, 'default') }));
  if (!orgRow) throw new Error('failed to find or create default org');
  const orgId = orgRow.id;

  console.log('[seed] Built-in roles...');
  for (const role of BUILTIN_ROLES) {
    const [r] = await db
      .insert(s.roles)
      .values({
        orgId,
        slug: role.slug,
        name: role.name,
        description: role.description,
        isBuiltIn: true,
        rank: role.rank,
      })
      .onConflictDoNothing({ target: [s.roles.orgId, s.roles.slug] })
      .returning();

    const roleRow =
      r ??
      (await db.query.roles.findFirst({
        where: (x, { eq, and }) => and(eq(x.orgId, orgId), eq(x.slug, role.slug)),
      }));
    if (!roleRow) continue;
    // A custom role may legitimately have claimed a future built-in slug
    // before this release. Never turn that collision into silent privilege
    // escalation by attaching the built-in permission bundle to it.
    if (!roleRow.isBuiltIn) {
      console.warn(`[seed] skip built-in role "${role.slug}": slug belongs to a custom role`);
      continue;
    }

    if (role.permissions.length) {
      await db
        .insert(s.rolePermissions)
        .values(role.permissions.map((key) => ({ roleId: roleRow.id, permissionKey: key })))
        .onConflictDoNothing();
    }
  }

  console.log('[seed] Stores...');
  for (const store of [
    { code: 'KITCHEN', name: 'Central Kitchen', sortIndex: 0 },
    { code: 'HOTEL', name: 'Riverside Hotel', sortIndex: 10 },
  ]) {
    await db
      .insert(s.stores)
      .values({ orgId, ...store })
      .onConflictDoNothing({ target: [s.stores.orgId, s.stores.code] });
  }

  console.log('[seed] Suppliers...');
  for (const sup of [
    { name: 'Chorsu Bazaar - Stall A12', rating: '4.50' },
    { name: 'Tashkent Wholesale Hub', rating: '4.20' },
    { name: 'Direct Farm - Yunusabad', rating: '4.80' },
  ]) {
    await db
      .insert(s.suppliers)
      .values({ orgId, name: sup.name, rating: sup.rating })
      .onConflictDoNothing();
  }

  console.log('[seed] Categories + SKUs...');
  const categories = [
    { slug: 'meat', names: { en: 'Meat', zh: '肉类', ru: 'Мясо', uz: "Go'sht" } },
    {
      slug: 'vegetables',
      names: {
        en: 'Vegetables',
        zh: '蔬菜',
        ru: 'Овощи',
        uz: 'Sabzavotlar',
      },
    },
    {
      slug: 'fruit',
      names: { en: 'Fruit', zh: '水果', ru: 'Фрукты', uz: 'Mevalar' },
    },
    {
      slug: 'dairy',
      names: {
        en: 'Dairy',
        zh: '乳制品',
        ru: 'Молочные',
        uz: 'Sutli',
      },
    },
    {
      slug: 'kitchen-tools',
      names: {
        en: 'Kitchen Tools',
        zh: '厨房工具',
        ru: 'Кухня',
        uz: 'Oshxona',
      },
    },
    {
      slug: 'linen',
      names: {
        en: 'Linen',
        zh: '布草',
        ru: 'Льняное',
        uz: 'Choyshab',
      },
    },
  ];
  for (let i = 0; i < categories.length; i++) {
    const c = categories[i]!;
    await db
      .insert(s.categories)
      .values({ orgId, slug: c.slug, names: c.names, sortIndex: i * 10 })
      .onConflictDoNothing({ target: [s.categories.orgId, s.categories.slug] });
  }

  const cats = await db.query.categories.findMany({ where: (x, { eq }) => eq(x.orgId, orgId) });
  const bySlug = new Map(cats.map((c) => [c.slug, c.id]));

  type SkuSeed = {
    catSlug: string;
    code: string;
    names: Record<string, string>;
    unit: string;
    step: string;
  };
  const skuRows: SkuSeed[] = [
    {
      catSlug: 'meat',
      code: 'BEEF',
      names: { en: 'Beef', zh: '牛肉', ru: 'Говядина', uz: "Mol go'shti" },
      unit: 'kg',
      step: '0.5',
    },
    {
      catSlug: 'meat',
      code: 'LAMB',
      names: { en: 'Lamb', zh: '羊肉', ru: 'Баранина', uz: "Qo'y go'shti" },
      unit: 'kg',
      step: '0.5',
    },
    {
      catSlug: 'meat',
      code: 'CHICKEN',
      names: { en: 'Chicken', zh: '鸡肉', ru: 'Курица', uz: 'Tovuq' },
      unit: 'kg',
      step: '0.5',
    },
    {
      catSlug: 'vegetables',
      code: 'TOMATO',
      names: { en: 'Tomato', zh: '番茄', ru: 'Помидор', uz: 'Pomidor' },
      unit: 'kg',
      step: '0.5',
    },
    {
      catSlug: 'vegetables',
      code: 'CUCUMBER',
      names: { en: 'Cucumber', zh: '黄瓜', ru: 'Огурец', uz: 'Bodring' },
      unit: 'kg',
      step: '0.5',
    },
    {
      catSlug: 'vegetables',
      code: 'ONION',
      names: { en: 'Onion', zh: '洋葱', ru: 'Лук', uz: 'Piyoz' },
      unit: 'kg',
      step: '0.5',
    },
    {
      catSlug: 'vegetables',
      code: 'POTATO',
      names: { en: 'Potato', zh: '土豆', ru: 'Картофель', uz: 'Kartoshka' },
      unit: 'kg',
      step: '0.5',
    },
    {
      catSlug: 'fruit',
      code: 'APPLE',
      names: { en: 'Apple', zh: '苹果', ru: 'Яблоко', uz: 'Olma' },
      unit: 'kg',
      step: '0.5',
    },
    {
      catSlug: 'fruit',
      code: 'BANANA',
      names: { en: 'Banana', zh: '香蕉', ru: 'Банан', uz: 'Banan' },
      unit: 'kg',
      step: '0.5',
    },
    {
      catSlug: 'dairy',
      code: 'MILK',
      names: { en: 'Milk', zh: '牛奶', ru: 'Молоко', uz: 'Sut' },
      unit: 'L',
      step: '0.5',
    },
    {
      catSlug: 'dairy',
      code: 'YOGURT',
      names: { en: 'Yogurt', zh: '酸奶', ru: 'Йогурт', uz: 'Qatiq' },
      unit: 'L',
      step: '0.5',
    },
    {
      catSlug: 'dairy',
      code: 'BUTTER',
      names: { en: 'Butter', zh: '黄油', ru: 'Масло', uz: 'Sariyog' },
      unit: 'kg',
      step: '0.5',
    },
    {
      catSlug: 'kitchen-tools',
      code: 'KNIFE',
      names: { en: 'Chef Knife', zh: '主厨刀', ru: 'Поварской нож', uz: 'Oshpaz pichoq' },
      unit: 'pcs',
      step: '1',
    },
    {
      catSlug: 'kitchen-tools',
      code: 'BOARD',
      names: { en: 'Cutting Board', zh: '砸板', ru: 'Доска', uz: 'Taxta' },
      unit: 'pcs',
      step: '1',
    },
    {
      catSlug: 'kitchen-tools',
      code: 'POT',
      names: { en: 'Stock Pot', zh: '汤锅', ru: 'Кастрюля', uz: 'Qozon' },
      unit: 'pcs',
      step: '1',
    },
    {
      catSlug: 'linen',
      code: 'TOWEL',
      names: { en: 'Bath Towel', zh: '浴巾', ru: 'Полотенце', uz: 'Sochiq' },
      unit: 'pcs',
      step: '1',
    },
    {
      catSlug: 'linen',
      code: 'SHEET',
      names: { en: 'Bed Sheet', zh: '床单', ru: 'Простыня', uz: 'Choyshab' },
      unit: 'pcs',
      step: '1',
    },
    {
      catSlug: 'linen',
      code: 'SLIPPER',
      names: { en: 'Slippers', zh: '拖鞋', ru: 'Тапочки', uz: 'Shippak' },
      unit: 'pair',
      step: '1',
    },
  ];

  for (let i = 0; i < skuRows.length; i++) {
    const r = skuRows[i]!;
    const categoryId = bySlug.get(r.catSlug);
    if (!categoryId) continue;
    await db
      .insert(s.skus)
      .values({
        orgId,
        categoryId,
        code: r.code,
        names: r.names,
        unit: r.unit,
        step: r.step,
        sortIndex: i * 10,
      })
      .onConflictDoNothing({ target: [s.skus.orgId, s.skus.code] });
  }

  console.log('[seed] Default feature flags...');
  await db
    .insert(s.featureFlags)
    .values([
      { orgId, key: 'price_alert.threshold_multiplier', value: { value: 1.2 } },
      { orgId, key: 'price_alert.threshold_uzs', value: { value: 10000 } },
      { orgId, key: 'order.default_step_for_kg', value: { value: 0.5 } },
      { orgId, key: 'workflow.skip_approval', value: { value: false } },
    ])
    .onConflictDoNothing();

  console.log('[seed] Done.');
  await closeDb();
}

main().catch((err) => {
  console.error('[seed] FAILED:', err);
  closeDb().finally(() => process.exit(1));
});

// Re-export so type-checkers don't complain about the unused import.
export const _ = sql;
