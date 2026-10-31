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
  // DLV-7 (2026-10-30): only those — the purchaser's page now links it.
  photoUrl: z
    .string()
    .max(300_000)
    .regex(/^(https?:\/\/|data:image\/)/i, 'photoUrl must be an http(s) or data:image URL')
    .nullable(),
  /**
   * 2026-10-21 CA-06: how much of this store's split actually arrived
   * (0 ≤ qty ≤ split qty, upper bound checked by the domain). Required
   * for 'short'; optional for 'wrong'/'quality' (defaults to 0); ignored
   * for 'ok'. Optional so older clients keep working — an older client
   * sending 'short' without it gets run.errors.receivedQtyRequired.
   */
  receivedQty: z
    .string()
    .regex(/^\d+(\.\d{1,3})?$/, 'common.errors.invalidDecimal')
    .nullable()
    .optional(),
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
