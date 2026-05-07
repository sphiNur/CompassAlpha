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
