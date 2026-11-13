import { z } from 'zod';
import { DateStringSchema, PhotoUrlSchema, UuidSchema } from './common';
import { PURCHASE_PRICE_RE } from '../limits';

export const RunStatusSchema = z.enum([
  'planned',
  'purchasing',
  'delivering',
  'finished',
  // 2026-07-06: a finished run reopened by a super-admin for correction.
  'amending',
  'cancelled',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/**
 * M1.14 (2026-05-08): payment method per recorded purchase. Same run
 * can mix cash and transfer items — the FinishRun event aggregates per-
 * method totals on the read model so accounting can reconcile petty
 * cash vs. bank statements separately.
 */
export const PaymentMethodSchema = z.enum(['cash', 'transfer']);
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

/** Server-side purchase-history search + pagination. */
export const RunHistoryInputSchema = z
  .object({
    search: z.string().trim().max(120).optional(),
    storeId: UuidSchema.optional(),
    dateFrom: DateStringSchema.optional(),
    dateTo: DateStringSchema.optional(),
    payment: z.enum(['cash', 'transfer', 'mixed']).optional(),
    sort: z.enum(['newest', 'oldest']).default('newest'),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(10).max(50).default(20),
  })
  .superRefine((value, ctx) => {
    if (value.dateFrom && value.dateTo && value.dateFrom > value.dateTo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dateTo'],
        // RUNAPI-19: a catalog key the client can show (was English).
        message: 'run.errors.invalidDateRange',
      });
    }
  });
export type RunHistoryInput = z.infer<typeof RunHistoryInputSchema>;

/**
 * RE-ENG-1 / BUY-15 (2026-10-30): what the columns can hold. Prices are
 * numeric(14,2): a third decimal was stored rounded, so reports and the
 * run's own total disagreed, and a 13th digit was a 500. Quantities are
 * numeric(12,3).
 */
export const PurchasePriceSchema = z
  .string()
  .regex(PURCHASE_PRICE_RE, 'run.errors.priceFormat')
  .refine((v) => Number(v) > 0, { message: 'run.errors.priceFormat' });
export const PurchaseQtySchema = z
  .string()
  .regex(/^\d{1,9}(\.\d{1,3})?$/, 'run.errors.qtyFormat')
  .refine((v) => Number(v) > 0, { message: 'run.errors.qtyFormat' });

export const StoreSplitSchema = z.object({
  storeId: UuidSchema,
  // Per-store qty must be > 0 — a 0-qty split is meaningless and causes
  // sum-mismatch downstream. Domain enforces too (defense-in-depth).
  qty: PurchaseQtySchema,
  /**
   * Optional per-store override for cases where the same SKU is bought
   * for different stores at different prices or payment paths. When
   * omitted, the item-level unitPrice/paymentMethod is used.
   */
  unitPrice: PurchasePriceSchema.optional(),
  paymentMethod: PaymentMethodSchema.optional(),
});

export const RunCreateInputSchema = z.object({
  // Defaults to the org's today. 2026-10-21 CA-03: the purchaser may pick
  // an earlier booking date; run.create rejects impossible and future
  // dates (org timezone).
  date: DateStringSchema.optional(),
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
 * live run. Allowed in planned/purchasing only — see run/decide/planning.ts. The
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
  unitPrice: PurchasePriceSchema,
  actualQty: PurchaseQtySchema,
  // An http(s) URL or a data:image URI (RUNAPI-24).
  receiptPhotoUrl: PhotoUrlSchema.nullable(),
  storeSplits: z.array(StoreSplitSchema).min(1),
  paymentMethod: PaymentMethodSchema,
  /**
   * The price is far from the last one paid (5× or more) and the
   * purchaser was shown both figures and said it is right. Recorded on
   * the event; never a condition for accepting the purchase — a refusal
   * would drop a purchase replayed from the offline queue.
   */
  priceConfirmed: z.boolean().optional(),
  expectedSeq: z.number().int().optional(),
});

/**
 * M3.41 (2026-05-21): purchaser-initiated mid-run addition. Same shape
 * as PurchaseItem but adds a required `reason` (audit string explaining
 * why the SKU wasn't on the original order) and the server-side
 * domain layer rejects skuId that's already in the run. See the
 * matching command in packages/domain/src/run/decide/purchasing.ts.
 */
export const AddPurchaserItemInputSchema = z.object({
  runId: UuidSchema,
  skuId: UuidSchema,
  supplierId: UuidSchema.nullable(),
  unitPrice: PurchasePriceSchema,
  actualQty: PurchaseQtySchema,
  receiptPhotoUrl: PhotoUrlSchema.nullable(),
  storeSplits: z.array(StoreSplitSchema).min(1),
  paymentMethod: PaymentMethodSchema,
  reason: z.string().trim().min(1).max(500),
  /** See PurchaseItemInputSchema. */
  priceConfirmed: z.boolean().optional(),
  expectedSeq: z.number().int().optional(),
});

/**
 * M3.44 (2026-05-22): off-catalog expense — free-text item OR shared
 * cost (porter, taxi, parking). Distinct from AddPurchaserItem because
 * there's no SKU foreign key. `expenseId` is CLIENT-generated so the
 * FE knows it before save (no roundtrip) and the same logical add
 * replays idempotently.
 *
 * The receipt photo is optional: the rule that required one above
 * 200,000 UZS was removed on 2026-07-06 (the reason is the audit trail).
 */
export const AddRunExpenseInputSchema = z.object({
  runId: UuidSchema,
  expenseId: UuidSchema,
  label: z.string().trim().min(1).max(200),
  unitHint: z.string().trim().max(32).optional(),
  qty: PurchaseQtySchema,
  unitPrice: PurchasePriceSchema,
  storeSplits: z.array(StoreSplitSchema).min(1),
  paymentMethod: PaymentMethodSchema,
  receiptPhotoUrl: PhotoUrlSchema.nullable(),
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

/** run.storeProgress: how far one store's part of a run has got (review ORD-26). */
export const RunStoreProgressInputSchema = z.object({
  runId: UuidSchema,
  storeId: UuidSchema,
});

/**
 * Correct the calendar date a run's spend is booked under (2026-07-30).
 * Super-admin only; see the RunDateChanged event docblock in
 * packages/domain/src/run/events.ts.
 */
export const ChangeRunDateInputSchema = z.object({
  runId: UuidSchema,
  /** YYYY-MM-DD. The domain re-validates and rejects impossible dates. */
  runDate: DateStringSchema,
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

/** Simplification (2026-11-13): the reason is optional (was min(1)); '' when none. */
export const UnmarkUnavailableInputSchema = z.object({
  runId: UuidSchema,
  skuId: UuidSchema,
  reason: z.string().trim().max(500).optional().default(''),
});

/** BUY-5: won't buy the demand that joined after the item was decided. */
export const DismissTopUpInputSchema = z.object({
  runId: UuidSchema,
  skuId: UuidSchema,
  note: z.string().max(500).optional(),
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

/** Simplification (2026-11-13): the reason is optional (was min(1)); '' when none. */
export const UndeliverStoreInputSchema = z.object({
  runId: UuidSchema,
  storeId: UuidSchema,
  reason: z.string().trim().max(500).optional().default(''),
});

/** reopen: a reason is required (the domain checks it again). */
export const RunReasonOnlyInputSchema = z.object({
  runId: UuidSchema,
  reason: z.string().min(1).max(500),
});

/**
 * A run step whose reason may be left out: cancel, and since the
 * simplification of 2026-11-13 undoStartPurchase / undoStartDelivery
 * (they took RunReasonOnlyInputSchema). '' when none.
 */
export const RunOptionalReasonInputSchema = z.object({
  runId: UuidSchema,
  reason: z.string().trim().max(500).optional().default(''),
});

/**
 * Cancel's reason is optional, so it cannot share `RunReasonOnlyInputSchema`
 * (which backs reopen, whose reason is required and enforced again in the
 * domain layer). It is RunOptionalReasonInputSchema, kept under this name.
 *
 * 2026-07-26: before this existed, cancel was broken end to end. The
 * domain deliberately allows an empty reason (run/decide/closing.ts CancelRun,
 * M1.7: "most cancels are misclicks; hard-requiring a reason produces
 * 'asdf' noise") and the FE deliberately sends one (RunPage's cancel
 * branch sets requireReason:false / reasonOptional:true) — but the
 * shared `.min(1)` in between rejected it at the tRPC boundary. Every
 * no-reason cancel died as a BAD_REQUEST behind a generic error toast.
 *
 * Relaxing the shared schema was the wrong fix: it would only move the
 * reopen's validation from the edge into a domain throw.
 * Mirrors `UndoPurchaseInputSchema`, which already models exactly this.
 */
export const RunCancelInputSchema = RunOptionalReasonInputSchema;
