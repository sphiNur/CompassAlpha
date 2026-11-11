/**
 * ADM2-09 (2026-11-11): the catalog inputs the admin and dishes routers
 * use live in schemas/catalog.ts. Pin the shared names rule (dishes had
 * their own copy) and that the form limits in ../limits are the ones the
 * schemas enforce.
 */
import { describe, expect, it } from 'bun:test';
import type { ZodTypeAny } from 'zod';
import { CATALOG_TEXT_MAX } from './limits';
import {
  CatalogNamesSchema,
  CategoryCreateInputSchema,
  DishSaveInputSchema,
  DishUpdateInputSchema,
  ExpenseTemplateCreateInputSchema,
  SkuCreateInputSchema,
  SupplierCreateInputSchema,
  TrimmedNameSchema,
} from './schemas/catalog';
import * as barrel from './index';

const DISH_ID = '00000000-0000-4000-8000-000000000001';

/** The first issue's message, or null when the value parses. */
function refusal(schema: ZodTypeAny, value: unknown): string | null {
  const result = schema.safeParse(value);
  return result.success ? null : (result.error.issues[0]?.message ?? 'refused');
}

describe('catalog names', () => {
  it('trims, drops blank languages and keeps the rest', () => {
    expect(CatalogNamesSchema.parse({ uz: '  ', ru: ' Guruch ', zh: '' })).toEqual({ ru: 'Guruch' });
  });

  it('refuses all-blank names with the caller’s key', () => {
    expect(refusal(CatalogNamesSchema, { uz: ' ', en: '' })).toBe('admin.errors.namesRequired');
    expect(refusal(DishSaveInputSchema, { names: { uz: ' ' }, ingredients: [] })).toBe(
      'dishes.errors.namesRequired',
    );
  });

  it('dishes use the same rule as products', () => {
    const dish = DishSaveInputSchema.parse({ names: { uz: '', ru: ' Plov ' }, ingredients: [] });
    expect(dish.names).toEqual({ ru: 'Plov' });
    // The old dishes copy took any key and kept control characters.
    expect(DishSaveInputSchema.safeParse({ names: { xx: 'Plov' }, ingredients: [] }).success).toBe(false);
    expect(refusal(DishSaveInputSchema, { names: { en: 'Pl\u001bov' }, ingredients: [] })).toBe(
      'common.errors.controlCharacters',
    );
    expect(refusal(DishSaveInputSchema, { names: { en: 'Plov' }, code: 'D\u0007', ingredients: [] })).toBe(
      'common.errors.controlCharacters',
    );
  });

  it('a dish sort order has the product bounds and key', () => {
    expect(refusal(DishUpdateInputSchema, { dishId: DISH_ID, sortIndex: 1.5 })).toBe(
      'admin.errors.sortIndexInteger',
    );
    expect(refusal(DishUpdateInputSchema, { dishId: DISH_ID, sortIndex: 2 ** 31 })).toBe(
      'admin.errors.sortIndexInteger',
    );
    expect(refusal(DishUpdateInputSchema, { dishId: DISH_ID, sortIndex: 3 })).toBeNull();
  });
});

describe('CATALOG_TEXT_MAX is what the schemas enforce', () => {
  const text = (n: number) => 'a'.repeat(n);
  const fits = (schema: ZodTypeAny, value: (n: number) => unknown, max: number) => {
    expect(schema.safeParse(value(max)).success).toBe(true);
    expect(schema.safeParse(value(max + 1)).success).toBe(false);
  };

  it('names, codes and slugs', () => {
    fits(CatalogNamesSchema, (n) => ({ en: text(n) }), CATALOG_TEXT_MAX.name);
    fits(TrimmedNameSchema, text, CATALOG_TEXT_MAX.name);
    fits(
      SkuCreateInputSchema,
      (n) => ({ names: { en: 'Rice' }, unit: 'kg', code: text(n) }),
      CATALOG_TEXT_MAX.skuCode,
    );
    fits(CategoryCreateInputSchema, (n) => ({ slug: text(n), names: { en: 'Veg' } }), CATALOG_TEXT_MAX.categorySlug);
    fits(
      DishSaveInputSchema,
      (n) => ({ names: { en: 'Plov' }, code: text(n), ingredients: [] }),
      CATALOG_TEXT_MAX.dishCode,
    );
  });

  it('supplier contact fields and the expense unit hint', () => {
    const supplier = (field: string) => (n: number) => ({ name: 'Bazaar', [field]: text(n) });
    fits(SupplierCreateInputSchema, supplier('contactPhone'), CATALOG_TEXT_MAX.phone);
    fits(SupplierCreateInputSchema, supplier('contactTg'), CATALOG_TEXT_MAX.telegram);
    fits(SupplierCreateInputSchema, supplier('address'), CATALOG_TEXT_MAX.address);
    fits(SupplierCreateInputSchema, supplier('notes'), CATALOG_TEXT_MAX.notes);
    fits(
      ExpenseTemplateCreateInputSchema,
      (n) => ({ label: 'Porter', defaultUnitPrice: '20000', unitHint: text(n) }),
      CATALOG_TEXT_MAX.unitHint,
    );
  });

  it('the barrel exports the limits and the router inputs', () => {
    expect(barrel.CATALOG_TEXT_MAX).toBe(CATALOG_TEXT_MAX);
    expect(barrel.SkuCreateInputSchema).toBe(SkuCreateInputSchema);
    expect(barrel.DishSaveInputSchema).toBe(DishSaveInputSchema);
  });
});
