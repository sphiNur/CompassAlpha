import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './auth';
import { opsSchema, pkUuid } from './_helpers';

export const notifications = opsSchema.table(
  'notifications',
  {
    id: pkUuid(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    recipientUserId: uuid('recipient_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: varchar('channel', { length: 16 }).notNull(), // bot|webpush|inapp
    template: varchar('template', { length: 64 }).notNull(),
    title: text('title').notNull(),
    body: text('body'),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    deepLink: text('deep_link'),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
    readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }),
    /** Idempotency: e.g. `order:${id}:submitted` so projector replays don't duplicate. */
    dedupKey: varchar('dedup_key', { length: 200 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    recipientIdx: index('notif_recipient_idx').on(t.recipientUserId, t.createdAt),
    dedupUnique: uniqueIndex('notif_dedup_unique').on(t.dedupKey).where(sql`dedup_key IS NOT NULL`),
  }),
);

export const auditLog = opsSchema.table(
  'audit_log',
  {
    id: pkUuid(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id),
    action: varchar('action', { length: 100 }).notNull(),
    resourceType: varchar('resource_type', { length: 64 }),
    resourceId: uuid('resource_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: varchar('ip', { length: 64 }),
    userAgent: text('user_agent'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgIdx: index('audit_org_idx').on(t.orgId, t.occurredAt),
    actorIdx: index('audit_actor_idx').on(t.actorId, t.occurredAt),
  }),
);

/**
 * Per-org client telemetry mirror â€?kept for offline forensics in addition to OTel.
 */
export const clientLogs = opsSchema.table(
  'client_logs',
  {
    id: pkUuid(),
    orgId: uuid('org_id'),
    userId: uuid('user_id'),
    sessionId: varchar('session_id', { length: 64 }).notNull(),
    level: varchar('level', { length: 8 }).notNull(),
    kind: varchar('kind', { length: 32 }).notNull(),
    action: varchar('action', { length: 64 }),
    target: varchar('target', { length: 200 }),
    data: jsonb('data'),
    errorMsg: text('error_msg'),
    errorStack: text('error_stack'),
    platform: varchar('platform', { length: 32 }),
    appVersion: varchar('app_version', { length: 32 }),
    traceId: varchar('trace_id', { length: 64 }),
    spanId: varchar('span_id', { length: 32 }),
    clientTs: bigint('client_ts', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdx: index('clog_user_idx').on(t.userId, t.createdAt),
    sessionIdx: index('clog_session_idx').on(t.sessionId, t.createdAt),
    createdIdx: index('clog_created_idx').on(t.createdAt),
    orgCreatedIdx: index('clog_org_created_idx').on(t.orgId, t.createdAt),
  }),
);

export const logReviewCursor = opsSchema.table('log_review_cursor', {
  orgId: uuid('org_id').primaryKey(),
  lastReviewedAt: timestamp('last_reviewed_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

/** Per-org runtime config: workflow definition, price-alert thresholds, feature toggles. */
export const featureFlags = opsSchema.table(
  'feature_flags',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 100 }).notNull(),
    value: jsonb('value').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pkIdx: uniqueIndex('flags_org_key_pk').on(t.orgId, t.key),
  }),
);

/** Web Push subscription endpoints. */
export const webPushSubscriptions = opsSchema.table(
  'web_push_subscriptions',
  {
    id: pkUuid(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    endpointUnique: uniqueIndex('webpush_endpoint_unique').on(t.endpoint),
    userIdx: index('webpush_user_idx').on(t.userId),
  }),
);

/** Offline command/event tally for ops dashboards. */
export const dailyMetrics = opsSchema.table(
  'daily_metrics',
  {
    orgId: uuid('org_id').notNull(),
    metricDate: varchar('metric_date', { length: 10 }).notNull(), // YYYY-MM-DD
    metric: varchar('metric', { length: 64 }).notNull(),
    value: integer('value').notNull().default(0),
    breakdown: jsonb('breakdown').default(sql`'{}'::jsonb`),
  },
  (t) => ({
    pkIdx: uniqueIndex('daily_metrics_pk').on(t.orgId, t.metricDate, t.metric),
  }),
);
