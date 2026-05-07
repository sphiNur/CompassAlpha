import { z } from 'zod';
import { UuidSchema } from './common';

export const ClientLogEventSchema = z.object({
  sessionId: z.string().min(1).max(64),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  kind: z.string().min(1).max(32),
  action: z.string().max(64).optional(),
  target: z.string().max(200).optional(),
  data: z.record(z.unknown()).optional(),
  errorMsg: z.string().optional(),
  errorStack: z.string().max(8000).optional(),
  platform: z.string().max(32).optional(),
  appVersion: z.string().max(32).optional(),
  traceId: z.string().max(64).optional(),
  spanId: z.string().max(32).optional(),
  clientTs: z.number().int(),
});

export const ClientLogBatchSchema = z.object({
  events: z.array(ClientLogEventSchema).min(1).max(100),
});

export const RecentLogsInputSchema = z.object({
  limit: z.number().int().min(1).max(500).default(100),
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  kind: z.string().max(32).optional(),
  userId: UuidSchema.optional(),
});

export const HealthSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  db: z.boolean(),
  redis: z.boolean(),
  projectorLag: z.number().int(),
  version: z.string(),
});
