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

/**
 * M1.14 (2026-05-08): payment method per recorded purchase. Same run
 * can mix cash and transfer items — the FinishRun event aggregates per-
 * method totals on the read model so accounting can reconcile petty
 * cash vs. bank statements separately.
 */
export const PaymentMethodSchema = z.enum(['cash', 'transfer']);
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

export const StoreSplitSchema = z.object({
  storeId: UuidSchema,
  // Per-store qty must be > 0 — a 0-qty split is meaningless and causes
  // sum-mismatch downstream. Domain enforces too (defense-in-depth).
  qty: PositiveDecimalStringSchema,
  /**
   * Optional per-store override for cases where the same SKU is bought
   * for different stores at different prices or payment paths. When
   * omitted, the item-level unitPrice/paymentMethod is used.
   */
  unitPrice: PositiveDecimalStringSchema.optional(),
  paymentMethod: PaymentMethodSchema.optional(),
});

export const RunCreateInputSchema = z.object({
  date: DateStringSchema.optional(), // defaults to today
  sessionIds: z.array(UuidSchema).min(1),
  /**
   * M1.13 (2026-05-08): atomically transition the new run from
   * `planned` → `purchasing` in the same call. The FE collapsed the
   * "+ New run" + "Start purchase" double-tap into a single CTA.
   * Server emits PlanRun + StartPurchase events in the same
   * transaction so projection lag never exposes a partial state.
   * Defaults to false to preserve the original two-step API for
   * existing tests / external callers.
   */
  startImmediately: z.boolean().optional(),
});

export const RunPreviewInputSchema = z.object({
  date: DateStringSchema.optional(),
});

/**
 * M3.31 A.2 (2026-05-18): attach more approved sessions to an existing
 * live run. Allowed in planned/purchasing only — see commands.ts. The
 * API aggregates the new sessions' demand into addedPlannedItems and
 * emits SessionsAttachedToRun on the run stream + AttachedToRun on
 * each new session stream (mirroring run.create's two-stream pattern).
 */
export const RunAttachSessionsInputSchema = z.object({
  runId: UuidSchema,
  sessionIds: z.array(UuidSchema).min(1),
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
  paymentMethod: PaymentMethodSchema,
  expectedSeq: z.number().int().optional(),
});

/**
 * M3.41 (2026-05-21): purchaser-initiated mid-run addition. Same shape
 * as PurchaseItem but adds a required `reason` (audit string explaining
 * why the SKU wasn't on the original order) and the server-side
 * domain layer rejects skuId that's already in the run. See the
 * matching command in packages/domain/src/run/commands.ts.
 */
export const AddPurchaserItemInputSchema = z.object({
  runId: UuidSchema,
  skuId: UuidSchema,
  supplierId: UuidSchema.nullable(),
  unitPrice: PositiveDecimalStringSchema,
  actualQty: PositiveDecimalStringSchema,
  receiptPhotoUrl: z.string().max(300_000).nullable(),
  storeSplits: z.array(StoreSplitSchema).min(1),
  paymentMethod: PaymentMethodSchema,
  reason: z.string().trim().min(1).max(500),
  expectedSeq: z.number().int().optional(),
});

/**
 * M3.44 (2026-05-22): off-catalog expense — free-text item OR shared
 * cost (porter, taxi, parking). Distinct from AddPurchaserItem because
 * there's no SKU foreign key. `expenseId` is CLIENT-generated so the
 * FE knows it before save (no roundtrip) and the same logical add
 * replays idempotently.
 *
 * Receipt photo is mandatory at the server when qty*unitPrice exceeds
 * a fixed threshold (200,000 UZS — see commands.ts:RECEIPT_THRESHOLD);
 * the FE shows the upload affordance from `receiptOptional` value
 * onwards so the user is never surprised at submit.
 */
export const AddRunExpenseInputSchema = z.object({
  runId: UuidSchema,
  expenseId: UuidSchema,
  label: z.string().trim().min(1).max(200),
  unitHint: z.string().trim().max(32).optional(),
  qty: PositiveDecimalStringSchema,
  unitPrice: PositiveDecimalStringSchema,
  storeSplits: z.array(StoreSplitSchema).min(1),
  paymentMethod: PaymentMethodSchema,
  receiptPhotoUrl: z.string().max(300_000).nullable(),
  reason: z.string().trim().min(1).max(500),
  expectedSeq: z.number().int().optional(),
});

export const RemoveRunExpenseInputSchema = z.object({
  runId: UuidSchema,
  expenseId: UuidSchema,
  reason: z.string().trim().max(500).optional().default(''),
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
