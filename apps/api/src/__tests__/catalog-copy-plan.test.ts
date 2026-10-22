/**
 * 2026-10-23: what a catalog copy creates and what it reuses
 * (services/catalogCopy.ts planCatalogCopy). Pure — runs everywhere.
 */
import { describe, expect, test } from 'bun:test';
import {
  planCatalogCopy,
  summarizePlan,
  type CatalogSnapshot,
  type ExistingCatalog,
} from '../services/catalogCopy';

const sku = (
  id: string,
  names: Record<string, string>,
  extra: Partial<CatalogSnapshot['skus'][number]> = {},
) => ({
  id,
  categoryId: 'cat-veg',
  code: null,
  names,
  aliases: {},
  description: {},
  unit: 'kg',
  step: '0.5',
  imageUrl: null,
  taxRatePct: null,
  sortIndex: 0,
  ...extra,
});

const supplier = (id: string, name: string) => ({
  id,
  name,
  contactPhone: null,
  contactTg: null,
  address: null,
  photoUrl: null,
  notes: null,
});

const source: CatalogSnapshot = {
  categories: [
    { id: 'cat-veg', slug: 'veg', names: { en: 'Vegetables' }, sortIndex: 0, icon: null },
    { id: 'cat-meat', slug: 'meat', names: { en: 'Meat' }, sortIndex: 1, icon: null },
  ],
  suppliers: [supplier('sup-1', 'Bazaar Ali'), supplier('sup-2', 'Fresh Co')],
  skus: [
    sku('sku-lemon', { en: 'Lemon', zh: '柠檬' }),
    sku('sku-onion', { en: 'Onion' }),
    sku('sku-beef', { en: 'Beef' }, { categoryId: 'cat-meat', code: 'B-1' }),
  ],
  links: [
    { skuId: 'sku-lemon', supplierId: 'sup-1', isPreferred: true },
    { skuId: 'sku-onion', supplierId: 'sup-2', isPreferred: false },
    { skuId: 'sku-beef', supplierId: 'sup-1', isPreferred: false },
  ],
};

const empty: ExistingCatalog = { categories: [], suppliers: [], skus: [] };

describe('planCatalogCopy', () => {
  test('an empty target gets everything', () => {
    const plan = planCatalogCopy(source, empty, { includeSuppliers: true });
    expect(summarizePlan(plan, source, true)).toEqual({
      categories: { created: 2, existing: 0 },
      suppliers: { created: 2, existing: 0 },
      skus: { created: 3, existing: 0 },
      links: { created: 3 },
    });
  });

  test('matching rows in the target are reused, not duplicated', () => {
    const target: ExistingCatalog = {
      categories: [{ id: 't-veg', slug: 'veg' }],
      suppliers: [{ id: 't-ali', name: '  bazaar  ALI ' }],
      skus: [
        // same Chinese name, different English one → still the same product
        { id: 't-lemon', code: null, names: { zh: '柠檬', en: 'Lemons' } },
        // same code
        { id: 't-beef', code: 'b-1', names: { ru: 'Говядина' } },
      ],
    };
    const plan = planCatalogCopy(source, target, { includeSuppliers: true });
    expect(plan.newCategories.map((c) => c.slug)).toEqual(['meat']);
    expect(plan.categoryIds.get('cat-veg')).toBe('t-veg');
    expect(plan.newSuppliers.map((s) => s.name)).toEqual(['Fresh Co']);
    expect(plan.supplierIds.get('sup-1')).toBe('t-ali');
    expect(plan.newSkus.map((k) => k.id)).toEqual(['sku-onion']);
    expect(plan.skuIds.get('sku-lemon')).toBe('t-lemon');
    expect(plan.skuIds.get('sku-beef')).toBe('t-beef');
    // only links of products that are new in the target
    expect(plan.newLinks).toEqual([
      { skuId: 'sku-onion', supplierId: 'sup-2', isPreferred: false },
    ]);
  });

  test('without suppliers nothing supplier-related is planned', () => {
    const plan = planCatalogCopy(source, empty, { includeSuppliers: false });
    expect(plan.newSuppliers).toEqual([]);
    expect(plan.newLinks).toEqual([]);
    expect(summarizePlan(plan, source, false).suppliers).toEqual({ created: 0, existing: 0 });
  });

  test('a same-name duplicate inside the source is created once', () => {
    const dup: CatalogSnapshot = {
      ...source,
      skus: [...source.skus, sku('sku-lemon-2', { en: 'lemon ' })],
      suppliers: [...source.suppliers, supplier('sup-3', 'fresh co')],
    };
    const plan = planCatalogCopy(dup, empty, { includeSuppliers: true });
    expect(plan.newSkus.map((k) => k.id)).toEqual(['sku-lemon', 'sku-onion', 'sku-beef']);
    expect(plan.newSuppliers.map((s) => s.id)).toEqual(['sup-1', 'sup-2']);
  });

  test('copying into a target that already has it all creates nothing', () => {
    const target: ExistingCatalog = {
      categories: source.categories.map((c) => ({ id: `t-${c.id}`, slug: c.slug })),
      suppliers: source.suppliers.map((s) => ({ id: `t-${s.id}`, name: s.name })),
      skus: source.skus.map((k) => ({ id: `t-${k.id}`, code: k.code, names: k.names })),
    };
    const summary = summarizePlan(
      planCatalogCopy(source, target, { includeSuppliers: true }),
      source,
      true,
    );
    expect(summary.categories.created + summary.suppliers.created + summary.skus.created).toBe(0);
    expect(summary.links.created).toBe(0);
  });
});
