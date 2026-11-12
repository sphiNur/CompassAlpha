/**
 * Seed for local development. Idempotent: re-running won't duplicate.
 *
 * Creates:
 *   - the organisation with slug `default`
 *   - permissions catalog (full PERMISSIONS list)
 *   - 6 built-in roles (BUILTIN_ROLES: super_admin, admin, manager,
 *     purchaser, cashier, staff)
 *   - 2 stores (Kitchen, Hotel)
 *   - 3 suppliers
 *   - 7 categories (i18n)
 *   - 18 SKUs (i18n)
 */
import { existsSync } from 'node:fs';
import { getDb, closeDb, schema as s } from './index';
import { PERMISSIONS, BUILTIN_ROLES, DEV_CATEGORIES, DEV_SKUS } from './seed-data';
import { DEFAULT_FEATURE_FLAGS, DEFAULT_ORG_WORKFLOW } from './provision-organization';
import { provisionSubscription } from './subscription';
import { PRODUCTION_UNIT_MARKER, productionReason } from './purgeGuard';
import { loadRepoEnv } from './repoEnv';

loadRepoEnv(import.meta.url);

/**
 * Review DB-02 (2026-11-09): this seed is for local development only. On a
 * server it would write demo stores, suppliers and products into the
 * organisation whose slug is `default` (a real customer since 0046), turn
 * its plan into 'legacy', and give the built-in roles back every key an
 * admin had removed. Existing organisations get a new built-in key from a
 * numbered migration (docs/RUNBOOK.md, "Add a new built-in permission").
 */
function refuseOnProduction(): void {
  const reason = productionReason({
    env: process.env,
    unitInstalled: existsSync(PRODUCTION_UNIT_MARKER),
  });
  if (!reason) return;
  console.error(
    `\x1b[31m✖ Refusing to seed: this looks like production (${reason}).\x1b[0m\n` +
      '  db:seed writes demo data for local development. To give existing\n' +
      '  organisations a new built-in permission, write a migration\n' +
      '  (docs/RUNBOOK.md, "Add a new built-in permission").',
  );
  process.exit(2);
}

async function main() {
  refuseOnProduction();
  const db = getDb(undefined, { system: 'maintenance' });
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
      name: 'Eden',
      localeDefault: 'en',
      timezone: 'Asia/Tashkent',
      workflow: DEFAULT_ORG_WORKFLOW,
    })
    .onConflictDoNothing({ target: s.organizations.slug })
    .returning();

  const orgRow =
    org ??
    (await db.query.organizations.findFirst({ where: (x, { eq }) => eq(x.slug, 'default') }));
  if (!orgRow) throw new Error('failed to find or create default org');
  const orgId = orgRow.id;
  await provisionSubscription(db, orgId, { planCode: 'legacy', status: 'active' });

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
  for (let i = 0; i < DEV_CATEGORIES.length; i++) {
    const c = DEV_CATEGORIES[i]!;
    await db
      .insert(s.categories)
      .values({ orgId, slug: c.slug, names: c.names, sortIndex: i * 10 })
      .onConflictDoNothing({ target: [s.categories.orgId, s.categories.slug] });
  }

  const cats = await db.query.categories.findMany({ where: (x, { eq }) => eq(x.orgId, orgId) });
  const bySlug = new Map(cats.map((c) => [c.slug, c.id]));

  for (let i = 0; i < DEV_SKUS.length; i++) {
    const r = DEV_SKUS[i]!;
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
    .values(DEFAULT_FEATURE_FLAGS.map((flag) => ({ orgId, ...flag })))
    .onConflictDoNothing();

  console.log('[seed] Done.');
  await closeDb();
}

main().catch((err) => {
  console.error('[seed] FAILED:', err);
  void closeDb().finally(() => process.exit(1));
});
