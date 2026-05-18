import { z } from 'zod';
import {
  DateStringSchema,
  DecimalStringSchema,
  IdempotencyKeySchema,
  UuidSchema,
} from './common';

export const OrderStatusSchema = z.enum([
  'draft',
  'submitted',
  'approved',
  'rejected',
  'in_run',
  'archived',
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const TodaySessionInputSchema = z.object({
  storeId: UuidSchema,
  date: DateStringSchema.optional(),
});

export const SessionDetailInputSchema = z.object({
  sessionId: UuidSchema,
});

export const OrderItemViewSchema = z.object({
  skuId: UuidSchema,
  qty: DecimalStringSchema,
  note: z.string().nullable(),
  lastEditedByUserId: UuidSchema.nullable(),
  lastEditedAt: z.string().nullable(),
});

export const OrderSessionViewSchema = z.object({
  id: UuidSchema,
  storeId: UuidSchema,
  memberId: UuidSchema,
  orderDate: DateStringSchema,
  status: OrderStatusSchema,
  claimedByMemberId: UuidSchema.nullable(),
  claimedAt: z.string().nullable(),
  submittedAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decidedByMemberId: UuidSchema.nullable(),
  rejectReason: z.string().nullable(),
  runId: UuidSchema.nullable(),
  lastSeq: z.number().int(),
  items: z.array(OrderItemViewSchema),
});

export const AdjustItemInputSchema = z.object({
  sessionId: UuidSchema.optional(), // omit for "today's session, auto-create draft"
  storeId: UuidSchema,
  date: DateStringSchema.optional(),
  skuId: UuidSchema,
  qty: DecimalStringSchema,
  /** Manager review: target a specific contributor's row. Requires
   *  `order.approve`. Omit (or pass own memberId) for normal staff edits. */
  targetMemberId: UuidSchema.optional(),
  expectedSeq: z.number().int().optional(),
  idempotencyKey: IdempotencyKeySchema.optional(),
});

export const SetNoteInputSchema = z.object({
  sessionId: UuidSchema,
  skuId: UuidSchema,
  note: z.string().max(500).nullable(),
  targetMemberId: UuidSchema.optional(),
  expectedSeq: z.number().int().optional(),
});

/**
 * Session-level free-text note ("其他物品", M1.8 2026-05-07). Distinct
 * from SetNoteInputSchema because it has no skuId/targetMemberId — the
 * note belongs to the session, not a line. 1000-char ceiling matches
 * the domain enforcement.
 */
export const SetSessionNoteInputSchema = z.object({
  sessionId: UuidSchema,
  note: z.string().max(1000).nullable(),
  expectedSeq: z.number().int().optional(),
});

/**
 * Canonical SKU units (M3.34, 2026-05-19). Same set the SKU schema
 * documents at packages/db/src/schema/inventory.ts. Extras now share
 * this enum so the FE dropdown and DB SKU.unit stay in sync — before
 * M3.34 the unit field was free-text and users typed "kg." "kgs" "公
 * 斤" inconsistently, breaking aggregation and i18n. The i18n labels
 * live at `unit.*` in each catalog.
 */
export const CanonicalUnitSchema = z.enum([
  'kg',
  'g',
  'L',
  'ml',
  'pcs',
  'pack',
  'pair',
  'bunch',
  'roll',
]);
export type CanonicalUnit = z.infer<typeof CanonicalUnitSchema>;

/**
 * One row in the structured "其他物品" list (M3.16-C, 2026-05-16).
 *
 * Field-by-field validation mirrors the domain-layer checks in
 * decide() so the API rejects bad shapes BEFORE we load the event
 * stream — saving a round-trip on the common case (manager typos a
 * decimal, FE didn't catch it).
 */
/**
 * M3.37 (2026-05-19, Wave2 #5): purchaser-side outcome on a single
 * extra row. Stored on the row itself so the read shape stays flat
 * for FE consumers. Optional + 'pending' default for legacy rows
 * written before M3.37.
 */
export const ExtraStatusSchema = z.enum(['pending', 'bought', 'unavailable']);
export type ExtraStatus = z.infer<typeof ExtraStatusSchema>;

export const SessionExtraItemSchema = z.object({
  name: z.string().min(1).max(200),
  qty: z.string().regex(/^\d+(\.\d{1,3})?$/, 'invalid qty'),
  // M3.34: tightened from free-text to canonical enum.
  unit: CanonicalUnitSchema,
  note: z.string().max(200).optional(),
  // M3.37: optional purchase outcome. Absent reads as 'pending'.
  status: ExtraStatusSchema.optional(),
});

/**
 * Input for MarkExtraStatus — M3.37 (2026-05-19, Wave2 #5). Bound by
 * sessionId + extraIndex; status is the new outcome. The session must
 * be `in_run` (server enforces); actor must hold `run.purchase`.
 */
export const MarkExtraStatusInputSchema = z.object({
  sessionId: UuidSchema,
  extraIndex: z.number().int().min(0).max(49),
  status: ExtraStatusSchema,
  expectedSeq: z.number().int().optional(),
});

export const SetSessionExtrasInputSchema = z.object({
  sessionId: UuidSchema,
  /** Max 50 rows per session — same hard cap the domain enforces. */
  extras: z.array(SessionExtraItemSchema).max(50),
  expectedSeq: z.number().int().optional(),
});

/** Query input — list of recently-used extra names for autocomplete. */
export const ExtrasSuggestionsInputSchema = z.object({
  storeId: UuidSchema,
  /** Optional prefix for type-ahead. Empty = top-N most-used. */
  search: z.string().max(100).optional(),
});

export const SimpleSessionCommandSchema = z.object({
  sessionId: UuidSchema,
  expectedSeq: z.number().int().optional(),
});

export const RejectInputSchema = SimpleSessionCommandSchema.extend({
  reason: z.string().min(1).max(500),
});

export const UnapproveInputSchema = SimpleSessionCommandSchema.extend({
  reason: z.string().max(500).optional(),
});

export const PendingListInputSchema = z.object({
  storeId: UuidSchema.optional(),
  date: DateStringSchema.optional(),
  status: OrderStatusSchema.optional(),
});
