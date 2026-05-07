import { sql } from 'drizzle-orm';
import { pgSchema, timestamp, uuid } from 'drizzle-orm/pg-core';

export const authSchema = pgSchema('auth');
export const inventorySchema = pgSchema('inventory');
export const domainSchema = pgSchema('domain');
export const readModelSchema = pgSchema('read_model');
export const opsSchema = pgSchema('ops');
export const syncSchema = pgSchema('sync');

/** Generate v7 UUID server-side via gen_random_uuid (UUIDv4 — good enough; v7 not yet in core PG). */
export const pkUuid = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

export const deletedAt = () => timestamp('deleted_at', { withTimezone: true, mode: 'date' });
