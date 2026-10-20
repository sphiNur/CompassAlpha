import { z } from 'zod';
import { UuidSchema } from './common';

export const ConfirmStatusSchema = z.enum(['ok', 'short', 'wrong', 'quality']);

export const DispatchInputSchema = z.object({
  runId: UuidSchema,
  storeId: UuidSchema,
  expectedSeq: z.number().int().optional(),
});

export const ConfirmStoreItemInputSchema = z.object({
  runId: UuidSchema,
  storeId: UuidSchema,
  skuId: UuidSchema,
  status: ConfirmStatusSchema,
  note: z.string().max(500).nullable(),
  // Accept both https URLs and data: URIs (M1 base64 fallback before S3 lands).
  photoUrl: z.string().max(300_000).nullable(),
  expectedSeq: z.number().int().optional(),
});

export const ConfirmStoreInputSchema = z.object({
  runId: UuidSchema,
  storeId: UuidSchema,
  expectedSeq: z.number().int().optional(),
});

/**
 * Bulk "all received correctly" action. This only writes item-level
 * `ok` confirmations; the separate store-level confirmation remains a
 * deliberate second step.
 */
export const MarkStoreItemsOkInputSchema = z.object({
  runId: UuidSchema,
  storeId: UuidSchema,
  skuIds: z.array(UuidSchema).min(1).max(500),
  expectedSeq: z.number().int().optional(),
});

export const DeliveryViewInputSchema = z.object({
  runId: UuidSchema,
  storeId: UuidSchema.optional(),
});
