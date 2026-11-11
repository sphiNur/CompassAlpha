/**
 * Catalog inputs: products (SKUs), categories, suppliers, expense
 * templates and dishes.
 *
 * ADM2-09 (2026-11-11): the admin and dishes routers declared these
 * inline, while this file held unused shapes that no longer matched them
 * (any-key names, an `imageUrl` no route takes). The routers now import
 * the schemas from here. The web imports only types and `../limits`
 * from this package (P-5); the forms' `maxLength` reads CATALOG_TEXT_MAX.
 */
import { z } from 'zod';
import { CONTROL_CHARS_MESSAGE, UuidSchema, noControlChars } from './common';
import { CATALOG_TEXT_MAX, PURCHASE_PRICE_RE, SKU_STEPS, SKU_UNITS } from '../limits';

// The lists live in ../limits (zod-free, P-5) so the web can import them
// without zod; re-exported here for the barrel.
export { CATALOG_TEXT_MAX, SKU_STEPS, SKU_UNITS };

/**
 * SKU unit (2026-07-30): a fixed vocabulary, not free text.
 *
 * Free-text units produced 个 / ta / Pcs / karobka / boglima /
 * "pcs（500g）" variants of the same thing in prod. The admin SKU
 * sheet renders a Select over this list and the API rejects anything
 * else; migration 0036 backfilled existing rows. `g` was retired —
 * weigh-and-pay goods are always kg (or L for liquids).
 */
export const SkuUnitSchema = z.enum(SKU_UNITS);
export type SkuUnit = z.infer<typeof SkuUnitSchema>;

/**
 * SKU step (M3.14, 2026-05-16): restricted to a canonical grid.
 *
 * 0.5          — weigh-and-pay goods (kg, L). One half-unit per +/- tap.
 * 1            — countable goods (pcs, pair, bunch, pack). One unit per tap.
 * 10 / 50 / 100 — bulk packaging goods (2026-07-30: takeaway boxes,
 *                wraps, napkins are bought 50-100 packs at a time; a
 *                +1 tap grid made those orders 100 taps).
 *
 * Any other value (0.25, 0.1, 5) is a contract violation; the API
 * rejects it and the admin SKU sheet renders a Select with these
 * options so it can't be mis-entered. Old rows are migrated (0023, 0036).
 */
export const SkuStepSchema = z.enum(SKU_STEPS);
export type SkuStep = z.infer<typeof SkuStepSchema>;

export const SkuListInputSchema = z.object({
  categoryId: UuidSchema.optional(),
  search: z.string().max(100).optional(),
  includeArchived: z.boolean().default(false),
});

/**
 * A catalog item's names, one per UI language. Products, categories and
 * dishes share this rule; `requiredMessage` is the catalog key shown
 * when every name is blank.
 *
 * 2026-10-21 CA-40: at least one language, not all four. Blank names are
 * dropped before storage so display fallbacks (`pickName`'s `??` chain)
 * skip them instead of rendering an empty string. F10: names are printed
 * by the operator's scripts, so no control characters. ADM2-09: dishes
 * had their own copy that kept blank names and accepted any key.
 */
export function catalogNamesSchema(requiredMessage: string) {
  const name = z.string().max(CATALOG_TEXT_MAX.name).optional();
  return z
    .object({ uz: name, ru: name, en: name, zh: name })
    .strict()
    .transform((v) => {
      const out: Partial<Record<'uz' | 'ru' | 'en' | 'zh', string>> = {};
      for (const k of ['uz', 'ru', 'en', 'zh'] as const) {
        const t = v[k]?.trim();
        if (t) out[k] = t;
      }
      return out;
    })
    .refine((v) => Object.keys(v).length > 0, { message: requiredMessage })
    .refine((v) => Object.values(v).every(noControlChars), { message: CONTROL_CHARS_MESSAGE });
}

/** Product and category names. */
export const CatalogNamesSchema = catalogNamesSchema('admin.errors.namesRequired');

/**
 * CAT-10 (2026-10-31): a sort position. A fractional or huge value came
 * back as zod's English "Expected integer" — "出错了" in the form — or
 * overflowed the int column as a 500.
 */
export const SortIndexSchema = z
  .number({ invalid_type_error: 'admin.errors.sortIndexInteger' })
  .int('admin.errors.sortIndexInteger')
  .min(-1_000_000, 'admin.errors.sortIndexInteger')
  .max(1_000_000, 'admin.errors.sortIndexInteger');

/**
 * A one-line name (supplier, expense template; the admin router's stores
 * and members use it too). ADM-11 (2026-10-30): trimmed before the length
 * check, so "   " is refused instead of stored. F10 (2026-10-31): no
 * control characters (an escape sequence in a store name reached the
 * operator's terminal through the ops scripts).
 */
export const TrimmedNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(CATALOG_TEXT_MAX.name)
  .refine(noControlChars, CONTROL_CHARS_MESSAGE);

/** A short code or hint: trimmed, at most `max` characters, no control characters. */
export const codeTextSchema = (max: number) =>
  z.string().trim().max(max).refine(noControlChars, CONTROL_CHARS_MESSAGE);

const SkuCodeSchema = z
  .string()
  .max(CATALOG_TEXT_MAX.skuCode)
  .refine(noControlChars, CONTROL_CHARS_MESSAGE);

// M3.14 (2026-05-16) restricted step to {'0.5','1'}; 2026-07-30 widened
// it to the canonical grid and locked unit to a fixed vocabulary. The
// admin sheet's Selects read the same lists, so they can't drift apart.
export const SkuCreateInputSchema = z.object({
  categoryId: UuidSchema.optional().nullable(),
  code: SkuCodeSchema.optional().nullable(),
  names: CatalogNamesSchema,
  unit: SkuUnitSchema,
  step: SkuStepSchema.default('1'),
  sortIndex: SortIndexSchema.default(0),
});

export const SkuUpdateInputSchema = z.object({
  skuId: UuidSchema,
  categoryId: UuidSchema.optional().nullable(),
  code: SkuCodeSchema.optional().nullable(),
  names: CatalogNamesSchema.optional(),
  unit: SkuUnitSchema.optional(),
  step: SkuStepSchema.optional(),
  sortIndex: SortIndexSchema.optional(),
  isArchived: z.boolean().optional(),
});

export const SkuDeleteInputSchema = z.object({
  skuId: UuidSchema,
});

const CategorySlugSchema = z
  .string()
  .min(1)
  .max(CATALOG_TEXT_MAX.categorySlug)
  .regex(/^[a-z0-9-]+$/);

export const CategoryCreateInputSchema = z.object({
  slug: CategorySlugSchema,
  names: CatalogNamesSchema,
  sortIndex: SortIndexSchema.default(0),
});

export const CategoryUpdateInputSchema = z.object({
  categoryId: UuidSchema,
  slug: CategorySlugSchema.optional(),
  names: CatalogNamesSchema.optional(),
  sortIndex: SortIndexSchema.optional(),
  isArchived: z.boolean().optional(),
});

export const CategoryDeleteInputSchema = z.object({
  categoryId: UuidSchema,
});

const supplierContact = {
  contactPhone: z.string().max(CATALOG_TEXT_MAX.phone).optional().nullable(),
  contactTg: z.string().max(CATALOG_TEXT_MAX.telegram).optional().nullable(),
  address: z.string().max(CATALOG_TEXT_MAX.address).optional().nullable(),
  notes: z.string().max(CATALOG_TEXT_MAX.notes).optional().nullable(),
};

export const SupplierCreateInputSchema = z.object({
  name: TrimmedNameSchema,
  ...supplierContact,
});

export const SupplierUpdateInputSchema = z.object({
  supplierId: UuidSchema,
  name: TrimmedNameSchema.optional(),
  ...supplierContact,
  isArchived: z.boolean().optional(),
});

export const SupplierDeleteInputSchema = z.object({
  supplierId: UuidSchema,
});

// M3.57 (2026-05-23): expense templates. `defaultUnitPrice` must be > 0
// because the auto-attach loop calls AddRunExpense, which checks for a
// positive price — a zero default would fail at run-create time and break
// the whole transaction. CAT-11 (2026-10-30): bounded to the columns (a
// 15-digit price was a 500, a third decimal was rounded away silently)
// and a quantity must be positive (a 0 default reached the purchaser as a
// 0-quantity line).
const ExpenseTemplateQtySchema = z.string().regex(/^(?!0+(\.0+)?$)\d{1,9}(\.\d{1,3})?$/);
const ExpenseTemplatePriceSchema = z.string().regex(/^(?!0+(\.0+)?$)\d{1,12}(\.\d{1,2})?$/);
const ExpenseTemplateUnitHintSchema = codeTextSchema(CATALOG_TEXT_MAX.unitHint);

export const ExpenseTemplateCreateInputSchema = z.object({
  label: TrimmedNameSchema,
  unitHint: ExpenseTemplateUnitHintSchema.optional().nullable(),
  defaultQty: ExpenseTemplateQtySchema.default('1'),
  defaultUnitPrice: ExpenseTemplatePriceSchema,
  defaultPaymentMethod: z.enum(['cash', 'transfer']).default('cash'),
  sortIndex: SortIndexSchema.default(0),
});

export const ExpenseTemplateUpdateInputSchema = z.object({
  templateId: UuidSchema,
  label: TrimmedNameSchema.optional(),
  unitHint: ExpenseTemplateUnitHintSchema.optional().nullable(),
  defaultQty: ExpenseTemplateQtySchema.optional(),
  defaultUnitPrice: ExpenseTemplatePriceSchema.optional(),
  defaultPaymentMethod: z.enum(['cash', 'transfer']).optional(),
  sortIndex: SortIndexSchema.optional(),
  isArchived: z.boolean().optional(),
});

export const ExpenseTemplateDeleteInputSchema = z.object({
  templateId: UuidSchema,
});

/** One recipe line: a product and how much of it one serving uses. */
export const DishIngredientSchema = z.object({
  skuId: UuidSchema,
  /** Decimal string with up to 4 fraction digits, must be > 0. */
  qtyPerServing: z
    .string()
    .regex(/^\d{1,8}(\.\d{1,4})?$/, 'dishes.errors.qtyTooLarge')
    .refine((v) => Number(v) > 0, { message: 'dishes.errors.ingredientQtyMustBePositive' }),
  note: z.string().max(500).optional().nullable(),
});
export type DishIngredientInput = z.infer<typeof DishIngredientSchema>;

const DishNamesSchema = catalogNamesSchema('dishes.errors.namesRequired');

/** A dish code: like a product code, no control characters (F10). */
const DishCodeSchema = z
  .string()
  .max(CATALOG_TEXT_MAX.dishCode)
  .refine(noControlChars, CONTROL_CHARS_MESSAGE);

const DishDescriptionSchema = z.record(z.string(), z.string().max(2000));

/**
 * A dish's sale price: the numeric(14,2) shape every price column has
 * (PURCHASE_PRICE_RE; CONF-08 kept one copy of the pattern).
 */
const DishPriceSchema = z.string().regex(PURCHASE_PRICE_RE, 'dishes.errors.priceTooLarge');

const DishIngredientsSchema = z.array(DishIngredientSchema).max(100);

export const DishCreateInputSchema = z.object({
  code: DishCodeSchema.optional().nullable(),
  names: DishNamesSchema,
  description: DishDescriptionSchema.optional(),
  unitPrice: DishPriceSchema.optional().nullable(),
  ingredients: DishIngredientsSchema,
});

export const DishUpdateInputSchema = z.object({
  dishId: UuidSchema,
  code: DishCodeSchema.optional().nullable(),
  names: DishNamesSchema.optional(),
  description: DishDescriptionSchema.optional(),
  unitPrice: DishPriceSchema.optional().nullable(),
  // ADM2-09: the CAT-10 bounds; a bare int() let 2^31 through as a 500.
  sortIndex: SortIndexSchema.optional(),
});

export const DishSetIngredientsInputSchema = z.object({
  dishId: UuidSchema,
  ingredients: DishIngredientsSchema,
});

export const DishSaveInputSchema = DishCreateInputSchema.extend({
  /** Absent → create a new dish; present → update that dish. */
  dishId: UuidSchema.optional(),
  /**
   * CLS-25 (2026-10-30): the dish's `updatedAt` when the editor opened it.
   * When given and the dish has changed since, the save is refused instead
   * of silently overwriting the other person's edit. Optional so clients
   * that don't send it keep working.
   */
  expectedUpdatedAt: z.string().datetime().optional(),
});
