import {
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { syncSchema, pkUuid } from './_helpers';

/**
 * Outbox pattern: events written in the same tx as their projection bump,
 * a worker picks them up and pushes to bot/webpush/realtime hub.
 */
export const outbox = syncSchema.table(
  'outbox',
  {
    id: pkUuid(),
    aggregate: varchar('aggregate', { length: 32 }).notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    eventId: uuid('event_id').notNull(),
    channel: varchar('channel', { length: 32 }).notNull(), // bot | webpush | realtime | excel | external
    payload: jsonb('payload').notNull(),
    retries: integer('retries').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pendingIdx: index('outbox_pending_idx').on(t.nextAttemptAt),
    eventIdx: index('outbox_event_idx').on(t.eventId),
  }),
);

/**
 * Idempotency cache. Mutations may include `Idempotency-Key`; we cache the
 * response for 24h so retries don't double-write.
 */
export const idempotencyKeys = syncSchema.table(
  'idempotency_keys',
  {
    key: varchar('key', { length: 128 }).primaryKey(),
    route: varchar('route', { length: 100 }).notNull(),
    userId: uuid('user_id'),
    response: jsonb('response'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    expiresIdx: index('idem_expires_idx').on(t.expiresAt),
    userRouteIdx: uniqueIndex('idem_user_route_unique').on(t.userId, t.route, t.key),
  }),
);
