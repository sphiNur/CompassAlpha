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

export const SettlementSaveInputSchema = SettlementGetInputSchema.extend({
  onlineRevenue: SettlementMoneySchema,
  invoicedCashRevenue: SettlementMoneySchema,
  operatingExpenses: SettlementMoneySchema,
  wagesPaid: SettlementMoneySchema,
  wagesAccrued: SettlementMoneySchema,
  nextPurchaseReserve: SettlementMoneySchema,
  priorPurchaseAdjustment: SignedSettlementMoneySchema,
  cashOnHand: SettlementMoneySchema,
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
