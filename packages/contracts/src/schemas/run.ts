import { z } from 'zod';
import {
  DateStringSchema,
  DecimalStringSchema,
  PositiveDecimalStringSchema,
  UuidSchema,
} from './common';

export const RunStatusSchema = z.enum([
  'planned',
  'purchasing',
  'delivering',
  'finished',
  'cancelled',
]);

export const StoreSplitSchema = z.object({
  storeId: UuidSchema,
  // Per-store qty must be > 0 — a 0-qty split is meaningless and causes
  // sum-mismatch downstream. Domain enforces too (defense-in-depth).
  qty: PositiveDecimalStringSchema,
});

export const RunCreateInputSchema = z.object({
  date: DateStringSchema.optional(), // defaults to today
  sessionIds: z.array(UuidSchema).min(1),
});

export const RunPreviewInputSchema = z.object({
  date: DateStringSchema.optional(),
});

export const PurchaseItemInputSchema = z.object({
  runId: UuidSchema,
  skuId: UuidSchema,
  supplierId: UuidSchema.nullable(),
  // Strictly > 0 (2026-05-05). Negative or zero would have corrupted
  // run totals — see PositiveDecimalStringSchema rationale.
  unitPrice: PositiveDecimalStringSchema,
  actualQty: PositiveDecimalStringSchema,
  // Accept both https URLs and data: URIs.
  receiptPhotoUrl: z.string().max(300_000).nullable(),
  storeSplits: z.array(StoreSplitSchema).min(1),
  expectedSeq: z.number().int().optional(),
});

export const MarkUnavailableInputSchema = z.object({
  runId: UuidSchema,
  skuId: UuidSchema,
  note: z.string().min(1).max(500),
  expectedSeq: z.number().int().optional(),
});

export const SimpleRunCommandSchema = z.object({
  runId: UuidSchema,
  expectedSeq: z.number().int().optional(),
});

export const EjectSessionInputSchema = SimpleRunCommandSchema.extend({
  sessionId: UuidSchema,
  reason: z.string().max(500).optional(),
});

// ---- Reversal command inputs (added 2026-05-03) ---------------------
// Every reversal carries a free-text reason — server-side enforced
// non-empty so the audit log can answer "why did this change?". The UI
// presents this as a small text field on the confirm sheet.

export const RevisePurchaseInputSchema = PurchaseItemInputSchema.extend({
  reason: z.string().min(1).max(500),
});

export const UnmarkUnavailableInputSchema = z.object({
  runId: UuidSchema,
  skuId: UuidSchema,
  reason: z.string().min(1).max(500),
});

/**
 * Undo a purchase = revert one row from `purchased` back to `pending`.
 * Reason was made optional 2026-05-04 — user feedback was that an
 * accidental "purchased" tap is so common (especially on mobile) that
 * forcing a reason felt like punishment for a typo. The state-revert
 * event still fires for projector mechanics; the audit log just gets
 * an empty `reason`. Cross-store delivery still blocks undo, so this
 * is only ever used while the row is freshly purchased and edit-able.
 */
export const UndoPurchaseInputSchema = z.object({
  runId: UuidSchema,
  skuId: UuidSchema,
  reason: z.string().max(500).optional().default(''),
});

export const UndeliverStoreInputSchema = z.object({
  runId: UuidSchema,
  storeId: UuidSchema,
  reason: z.string().min(1).max(500),
});

export const RunReasonOnlyInputSchema = z.object({
  runId: UuidSchema,
  reason: z.string().min(1).max(500),
});

export const RunItemViewSchema = z.object({
  skuId: UuidSchema,
  plannedQty: DecimalStringSchema,
  purchasedQty: DecimalStringSchema.nullable(),
  supplierId: UuidSchema.nullable(),
  unitPrice: DecimalStringSchema.nullable(),
  status: z.enum(['pending', 'purchased', 'unavailable']),
  unavailableNote: z.string().nullable(),
  receiptPhotoUrl: z.string().nullable(),
});

export const RunViewSchema = z.object({
  id: UuidSchema,
  runDate: DateStringSchema,
  runIndex: z.number().int(),
  status: RunStatusSchema,
  plannedTotal: DecimalStringSchema.nullable(),
  actualTotal: DecimalStringSchema.nullable(),
  purchaserMemberId: UuidSchema.nullable(),
  sessionIds: z.array(UuidSchema),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  lastSeq: z.number().int(),
  items: z.array(RunItemViewSchema),
});
