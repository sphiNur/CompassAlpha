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

export const DeliveryViewInputSchema = z.object({
  runId: UuidSchema,
  storeId: UuidSchema.optional(),
});
