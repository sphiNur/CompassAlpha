import { z } from 'zod';
import { DecimalStringSchema, I18nNamesSchema, UuidSchema } from './common';

export const CategorySchema = z.object({
  id: UuidSchema,
  slug: z.string(),
  names: I18nNamesSchema,
  sortIndex: z.number().int(),
  icon: z.string().nullable(),
  isArchived: z.boolean(),
});

/**
 * SKU unit (2026-07-30): a fixed vocabulary, not free text.
 *
 * Free-text units produced 个 / ta / Pcs / karobka / boglima /
 * "pcs（500g）" variants of the same thing in prod. The admin SKU
 * sheet renders a Select over this list and the API rejects anything
 * else; migration 0036 backfilled existing rows. `g` was retired —
 * weigh-and-pay goods are always kg (or L for liquids).
 */
export const SkuUnitSchema = z.enum(['kg', 'L', 'pcs', 'pack', 'bunch', 'box', 'roll', 'pair']);
export type SkuUnit = z.infer<typeof SkuUnitSchema>;
export const SKU_UNITS = SkuUnitSchema.options;

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
export const SkuStepSchema = z.enum(['0.5', '1', '10', '50', '100']);
export type SkuStep = z.infer<typeof SkuStepSchema>;
export const SKU_STEPS = SkuStepSchema.options;

export const SkuSchema = z.object({
  id: UuidSchema,
  categoryId: UuidSchema.nullable(),
  code: z.string().nullable(),
  names: I18nNamesSchema,
  unit: z.string(),
  step: SkuStepSchema,
  imageUrl: z.string().nullable(),
  suggestedQty: DecimalStringSchema.nullable(),
  sortIndex: z.number().int(),
  isArchived: z.boolean(),
});

export const SupplierSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  contactPhone: z.string().nullable(),
  contactTg: z.string().nullable(),
  rating: DecimalStringSchema.nullable(),
  reliabilityScore: DecimalStringSchema.nullable(),
  priceTrustScore: DecimalStringSchema.nullable(),
  photoUrl: z.string().nullable(),
  isArchived: z.boolean(),
});

export const StoreSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  code: z.string().nullable(),
  address: z.string().nullable(),
  sortIndex: z.number().int(),
  isActive: z.boolean(),
});

export const SkuListInputSchema = z.object({
  categoryId: UuidSchema.optional(),
  search: z.string().max(100).optional(),
  includeArchived: z.boolean().default(false),
});

export const SkuUpsertInputSchema = z.object({
  id: UuidSchema.optional(),
  categoryId: UuidSchema.nullable(),
  code: z.string().max(64).nullable(),
  names: I18nNamesSchema,
  unit: SkuUnitSchema,
  step: SkuStepSchema,
  imageUrl: z.string().url().nullable(),
});

export const CategoryUpsertInputSchema = z.object({
  id: UuidSchema.optional(),
  slug: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  names: I18nNamesSchema,
  icon: z.string().max(64).nullable(),
  sortIndex: z.number().int().default(0),
});
