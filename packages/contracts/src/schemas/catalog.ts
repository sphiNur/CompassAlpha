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

export const SkuSchema = z.object({
  id: UuidSchema,
  categoryId: UuidSchema.nullable(),
  code: z.string().nullable(),
  names: I18nNamesSchema,
  unit: z.string(),
  step: DecimalStringSchema,
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
  unit: z.string().min(1).max(16),
  step: DecimalStringSchema,
  imageUrl: z.string().url().nullable(),
});

export const CategoryUpsertInputSchema = z.object({
  id: UuidSchema.optional(),
  slug: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  names: I18nNamesSchema,
  icon: z.string().max(64).nullable(),
  sortIndex: z.number().int().default(0),
});
