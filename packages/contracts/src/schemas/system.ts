import { z } from 'zod';
import { UuidSchema } from './common';

export const RecentLogsInputSchema = z.object({
  limit: z.number().int().min(1).max(500).default(100),
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  kind: z.string().max(32).optional(),
  userId: UuidSchema.optional(),
});
