import { z } from 'zod';
import { DateStringSchema, UuidSchema } from './common';

export const PurgeTestDataInputSchema = z.object({
  dateFrom: DateStringSchema,
  dateTo: DateStringSchema,
  storeId: UuidSchema.optional(),
  dryRun: z.boolean().default(true),
  expectedCount: z.number().int().nonnegative().optional(),
});

export const PurgeTestDataResultSchema = z.object({
  dryRun: z.boolean(),
  total: z.number().int(),
  byTable: z.record(z.number().int()),
});

export const GrantRoleInputSchema = z.object({
  userId: UuidSchema,
  roleSlug: z.string(),
  scopeType: z.enum(['global', 'store']).default('global'),
  scopeId: UuidSchema.optional(),
  expiresAt: z.string().optional(),
});

export const InviteMemberInputSchema = z.object({
  tgUsername: z.string().min(1).max(64).optional(),
  email: z.string().email().optional(),
  roleSlug: z.string(),
});
