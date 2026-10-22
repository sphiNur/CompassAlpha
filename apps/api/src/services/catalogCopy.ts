/**
 * Copy one organisation's catalog into another (2026-10-23).
 *
 * What travels: categories, products (names, aliases, notes, unit, step,
 * image, tax override, order) and, when asked, suppliers with their
 * product links. What stays behind: anything the source org earned by
 * trading — price history, last-seen and default prices, stock, supplier
 * trust scores, suggested quantities, per-store supplier preferences.
 * Archived rows are not copied.
 *
 * Nothing already in the target is changed. A source row that matches a
 * target row (category by slug, supplier by name, product by code or by
 * any shared-language name) is skipped and its target twin is reused, so
 * running the copy twice adds nothing the second time.
 *
 * Tenant isolation is never suspended: the source is read in a
 * transaction bound to the source org and the target is written in one
 * bound to the target org (see readCatalogSnapshot / applyCatalogCopy).
 * The caller decides who may do this — the CLI script is an operator
 * tool; admin.catalogImport requires org.admin in both orgs.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { DB } from '@compass/db';
import { schema as s } from '@compass/db';

type Names = Record<string, string>;

export type SnapshotCategory = {
  id: string;
  slug: string;
  names: Names;
  sortIndex: number;
  icon: string | null;
};

export type SnapshotSupplier = {
  id: string;
  name: string;
  contactPhone: string | null;
  contactTg: string | null;
  address: string | null;
  photoUrl: string | null;
  notes: string | null;
};

export type SnapshotSku = {
  id: string;
  categoryId: string | null;
  code: string | null;
  names: Names;
  aliases: unknown;
  description: unknown;
  unit: string;
  step: string;
  imageUrl: string | null;
  taxRatePct: string | null;
  sortIndex: number;
};

export type SnapshotLink = { skuId: string; supplierId: string; isPreferred: boolean };

export type CatalogSnapshot = {
  categories: SnapshotCategory[];
  suppliers: SnapshotSupplier[];
  skus: SnapshotSku[];
  links: SnapshotLink[];
};

export type ExistingCatalog = {
  categories: Array<{ id: string; slug: string }>;
  suppliers: Array<{ id: string; name: string }>;
  skus: Array<{ id: string; code: string | null; names: Names }>;
};

export type CatalogCopyPlan = {
  /** Source id → target id for every row that will exist in the target. */
  categoryIds: Map<string, string | null>;
  supplierIds: Map<string, string | null>;
  skuIds: Map<string, string | null>;
  newCategories: SnapshotCategory[];
  newSuppliers: SnapshotSupplier[];
  newSkus: SnapshotSku[];
  /** Links whose product is new in the target. */
  newLinks: SnapshotLink[];
};

export type CatalogCopySummary = {
  categories: { created: number; existing: number };
  suppliers: { created: number; existing: number };
  skus: { created: number; existing: number };
  links: { created: number };
};

const norm = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();

/** Every non-empty name of a product, tagged by language. */
function nameKeys(names: Names): string[] {
  return Object.entries(names ?? {})
    .filter(([, v]) => typeof v === 'string' && v.trim() !== '')
    .map(([lang, v]) => `${lang}:${norm(v)}`);
}

/**
 * Decide what to create and what already exists. Pure: target ids for
 * rows that will be created are left null until applyCatalogCopy inserts
 * them.
 */
export function planCatalogCopy(
  source: CatalogSnapshot,
  target: ExistingCatalog,
  options: { includeSuppliers: boolean },
): CatalogCopyPlan {
  const categoryBySlug = new Map(target.categories.map((c) => [c.slug, c.id]));
  const categoryIds = new Map<string, string | null>();
  const newCategories: SnapshotCategory[] = [];
  for (const c of source.categories) {
    const existing = categoryBySlug.get(c.slug);
    categoryIds.set(c.id, existing ?? null);
    if (!existing) {
      newCategories.push(c);
      // Two source categories never share a slug (unique per org), but
      // keep the map honest anyway.
      categoryBySlug.set(c.slug, '');
    }
  }

  const supplierIds = new Map<string, string | null>();
  const newSuppliers: SnapshotSupplier[] = [];
  if (options.includeSuppliers) {
    const supplierByName = new Map(target.suppliers.map((sp) => [norm(sp.name), sp.id]));
    for (const sp of source.suppliers) {
      const key = norm(sp.name);
      const existing = supplierByName.get(key);
      if (existing !== undefined) {
        // '' = a same-name duplicate within the source; it is not
        // created twice and its links are dropped.
        supplierIds.set(sp.id, existing || null);
        continue;
      }
      supplierIds.set(sp.id, null);
      newSuppliers.push(sp);
      supplierByName.set(key, '');
    }
  }

  const skuByCode = new Map<string, string>();
  const skuByName = new Map<string, string>();
  for (const k of target.skus) {
    if (k.code) skuByCode.set(norm(k.code), k.id);
    for (const key of nameKeys(k.names)) skuByName.set(key, k.id);
  }
  const skuIds = new Map<string, string | null>();
  const newSkus: SnapshotSku[] = [];
  for (const k of source.skus) {
    const byCode = k.code ? skuByCode.get(norm(k.code)) : undefined;
    const byName = nameKeys(k.names)
      .map((key) => skuByName.get(key))
      .find((id) => id !== undefined);
    const existing = byCode ?? byName;
    if (existing !== undefined) {
      skuIds.set(k.id, existing || null);
      continue;
    }
    skuIds.set(k.id, null);
    newSkus.push(k);
    if (k.code) skuByCode.set(norm(k.code), '');
    for (const key of nameKeys(k.names)) skuByName.set(key, '');
  }

  const newSkuIds = new Set(newSkus.map((k) => k.id));
  const newLinks = options.includeSuppliers
    ? source.links.filter((l) => newSkuIds.has(l.skuId) && supplierIds.has(l.supplierId))
    : [];

  return { categoryIds, supplierIds, skuIds, newCategories, newSuppliers, newSkus, newLinks };
}

export function summarizePlan(
  plan: CatalogCopyPlan,
  source: CatalogSnapshot,
  includeSuppliers: boolean,
): CatalogCopySummary {
  return {
    categories: {
      created: plan.newCategories.length,
      existing: source.categories.length - plan.newCategories.length,
    },
    suppliers: includeSuppliers
      ? {
          created: plan.newSuppliers.length,
          existing: source.suppliers.length - plan.newSuppliers.length,
        }
      : { created: 0, existing: 0 },
    skus: { created: plan.newSkus.length, existing: source.skus.length - plan.newSkus.length },
    links: { created: plan.newLinks.length },
  };
}

/** Read the source catalog. `tx` must be bound to `orgId`. */
export async function readCatalogSnapshot(tx: DB, orgId: string): Promise<CatalogSnapshot> {
  const [categories, suppliers, skus] = await Promise.all([
    tx
      .select({
        id: s.categories.id,
        slug: s.categories.slug,
        names: s.categories.names,
        sortIndex: s.categories.sortIndex,
        icon: s.categories.icon,
      })
      .from(s.categories)
      .where(and(eq(s.categories.orgId, orgId), eq(s.categories.isArchived, false)))
      .orderBy(s.categories.sortIndex),
    tx
      .select({
        id: s.suppliers.id,
        name: s.suppliers.name,
        contactPhone: s.suppliers.contactPhone,
        contactTg: s.suppliers.contactTg,
        address: s.suppliers.address,
        photoUrl: s.suppliers.photoUrl,
        notes: s.suppliers.notes,
      })
      .from(s.suppliers)
      .where(and(eq(s.suppliers.orgId, orgId), eq(s.suppliers.isArchived, false)))
      .orderBy(s.suppliers.name),
    tx
      .select({
        id: s.skus.id,
        categoryId: s.skus.categoryId,
        code: s.skus.code,
        names: s.skus.names,
        aliases: s.skus.aliases,
        description: s.skus.description,
        unit: s.skus.unit,
        step: s.skus.step,
        imageUrl: s.skus.imageUrl,
        taxRatePct: s.skus.taxRatePct,
        sortIndex: s.skus.sortIndex,
      })
      .from(s.skus)
      .where(and(eq(s.skus.orgId, orgId), eq(s.skus.isArchived, false)))
      .orderBy(s.skus.sortIndex),
  ]);
  const skuIds = skus.map((k) => k.id);
  const links =
    skuIds.length > 0
      ? await tx
          .select({
            skuId: s.skuSupplierLinks.skuId,
            supplierId: s.skuSupplierLinks.supplierId,
            isPreferred: s.skuSupplierLinks.isPreferred,
          })
          .from(s.skuSupplierLinks)
          .where(inArray(s.skuSupplierLinks.skuId, skuIds))
      : [];
  return {
    categories: categories.map((c) => ({ ...c, names: (c.names ?? {}) as Names })),
    suppliers,
    skus: skus.map((k) => ({ ...k, names: (k.names ?? {}) as Names })),
    links,
  };
}

/** What the target already has, archived rows included (codes stay unique). */
async function readExisting(tx: DB, orgId: string): Promise<ExistingCatalog> {
  const [categories, suppliers, skus] = await Promise.all([
    tx
      .select({ id: s.categories.id, slug: s.categories.slug })
      .from(s.categories)
      .where(eq(s.categories.orgId, orgId)),
    tx
      .select({ id: s.suppliers.id, name: s.suppliers.name })
      .from(s.suppliers)
      .where(eq(s.suppliers.orgId, orgId)),
    tx
      .select({ id: s.skus.id, code: s.skus.code, names: s.skus.names })
      .from(s.skus)
      .where(eq(s.skus.orgId, orgId)),
  ]);
  return {
    categories,
    suppliers,
    skus: skus.map((k) => ({ ...k, names: (k.names ?? {}) as Names })),
  };
}

/**
 * Write the copy into the target. `tx` must be bound to `targetOrgId`.
 * With `dryRun` nothing is written and the summary says what would be.
 */
export async function applyCatalogCopy(
  tx: DB,
  targetOrgId: string,
  source: CatalogSnapshot,
  options: { includeSuppliers: boolean; dryRun: boolean },
): Promise<CatalogCopySummary> {
  const existing = await readExisting(tx, targetOrgId);
  const plan = planCatalogCopy(source, existing, options);
  const summary = summarizePlan(plan, source, options.includeSuppliers);
  if (options.dryRun) return summary;

  for (const c of plan.newCategories) {
    const [row] = await tx
      .insert(s.categories)
      .values({
        orgId: targetOrgId,
        slug: c.slug,
        names: c.names,
        sortIndex: c.sortIndex,
        icon: c.icon,
      })
      .returning({ id: s.categories.id });
    plan.categoryIds.set(c.id, row!.id);
  }

  for (const sp of plan.newSuppliers) {
    const [row] = await tx
      .insert(s.suppliers)
      .values({
        orgId: targetOrgId,
        name: sp.name,
        contactPhone: sp.contactPhone,
        contactTg: sp.contactTg,
        address: sp.address,
        photoUrl: sp.photoUrl,
        notes: sp.notes,
      })
      .returning({ id: s.suppliers.id });
    plan.supplierIds.set(sp.id, row!.id);
  }

  for (const k of plan.newSkus) {
    const [row] = await tx
      .insert(s.skus)
      .values({
        orgId: targetOrgId,
        categoryId: k.categoryId ? (plan.categoryIds.get(k.categoryId) ?? null) : null,
        code: k.code,
        names: k.names,
        aliases: k.aliases ?? {},
        description: k.description ?? {},
        unit: k.unit,
        step: k.step,
        imageUrl: k.imageUrl,
        taxRatePct: k.taxRatePct,
        sortIndex: k.sortIndex,
      })
      .returning({ id: s.skus.id });
    plan.skuIds.set(k.id, row!.id);
  }

  const linkRows = plan.newLinks.flatMap((l) => {
    const skuId = plan.skuIds.get(l.skuId);
    const supplierId = plan.supplierIds.get(l.supplierId);
    return skuId && supplierId ? [{ skuId, supplierId, isPreferred: l.isPreferred }] : [];
  });
  if (linkRows.length > 0) {
    await tx.insert(s.skuSupplierLinks).values(linkRows).onConflictDoNothing();
  }
  summary.links.created = linkRows.length;
  return summary;
}
