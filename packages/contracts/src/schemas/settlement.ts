import { z } from 'zod';
import { DateStringSchema, UuidSchema } from './common';

/** Money is transported as a decimal string to avoid float drift. */
export const SettlementMoneySchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'invalid money amount')
  .refine((value) => Number(value) <= 999_999_999_999.99, {
    message: 'money amount is too large',
  });

/** Previous-procurement carry may be debt (+) or unused credit (-). */
export const SignedSettlementMoneySchema = z
  .string()
  .regex(/^-?\d{1,12}(\.\d{1,2})?$/, 'invalid signed money amount')
  .refine((value) => Math.abs(Number(value)) <= 999_999_999_999.99, {
    message: 'money amount is too large',
  });

export const SettlementGetInputSchema = z.object({
  storeId: UuidSchema,
  /** Defaults to today in the selected store's timezone. */
  date: DateStringSchema.optional(),
});

/** Resolve the authoritative current business date for one store. */
export const SettlementBusinessDateInputSchema = z.object({
  storeId: UuidSchema,
});

/** Active personnel available to select for wages in one store. */
export const SettlementWageRosterInputSchema = z.object({
  storeId: UuidSchema,
});

/**
 * A single explained day-to-day operating outflow in a daily close.
 *
 * `id` is assigned by the server when the row is first stored.  It lets the
 * API retain the immutable audit attribution for an existing row while a
 * manager corrects its amount or reason.  Clients must never send an actor
 * identity; the API obtains that from the authenticated session.
 */
export const SettlementOperatingExpenseItemSchema = z.object({
  id: UuidSchema.optional(),
  amount: SettlementMoneySchema.refine((value) => Number(value) > 0, {
    message: 'expense amount must be greater than zero',
  }),
  /** Why this outflow was necessary. Required for an auditable close. */
  reason: z.string().trim().min(1).max(500),
});

/**
 * One store employee's paid or still-payable wage for this business date.
 * New or changed wage rows must carry `memberId`; the server validates it
 * against the selected store and snapshots the current display name. The
 * optional `personName` is retained only so an already-deployed older client
 * can re-save an untouched historical row. It is never trusted for a new or
 * changed recipient.
 */
export const SettlementWageItemSchema = z.object({
  /** Stable server-generated identity for preserving a historical wage snapshot. */
  id: UuidSchema.optional(),
  memberId: UuidSchema.optional(),
  personName: z.string().trim().min(1).max(160).optional(),
  status: z.enum(['paid', 'unpaid']),
  amount: SettlementMoneySchema.refine((value) => Number(value) > 0, {
    message: 'wage amount must be greater than zero',
  }),
  /** Shift, pay period, allowance, or another explanation for the wage. */
  reason: z.string().trim().min(1).max(500),
});

export const SettlementSaveInputSchema = SettlementGetInputSchema.extend({
  onlineRevenue: SettlementMoneySchema,
  invoicedCashRevenue: SettlementMoneySchema,
  operatingExpenses: SettlementMoneySchema,
  wagesPaid: SettlementMoneySchema,
  wagesAccrued: SettlementMoneySchema,
  nextPurchaseReserve: SettlementMoneySchema,
  priorPurchaseAdjustment: SignedSettlementMoneySchema,
  cashOnHand: SettlementMoneySchema,
  /**
   * When present, these are the source of truth for operatingExpenses.
   * Optional only for an unchanged re-save from an older client; non-zero
   * outflows on a new or corrected close always require their detail rows.
   */
  operatingExpenseItems: z.array(SettlementOperatingExpenseItemSchema).max(100).optional(),
  /**
   * Paid rows derive wagesPaid; unpaid rows derive wagesAccrued. See the
   * compatibility note above for why this stays optional instead of
   * defaulting to an empty array.
   */
  wageItems: z.array(SettlementWageItemSchema).max(100).optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  /** Required by the API whenever an existing settlement is corrected. */
  correctionReason: z.string().trim().max(500).nullable().optional(),
  /** 0 creates; an existing record must supply its current version. */
  expectedVersion: z.number().int().nonnegative(),
});

export const SettlementRecentInputSchema = z.object({
  storeId: UuidSchema,
  beforeDate: DateStringSchema.optional(),
  limit: z.number().int().min(1).max(31).default(7),
});

export type SettlementSaveInput = z.infer<typeof SettlementSaveInputSchema>;
export type SettlementOperatingExpenseItem = z.infer<typeof SettlementOperatingExpenseItemSchema>;
export type SettlementWageItem = z.infer<typeof SettlementWageItemSchema>;
