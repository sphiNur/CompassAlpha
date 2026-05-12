import { sql } from 'drizzle-orm';
import {
  bigint,
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
import { domainSchema, pkUuid } from './_helpers';

/**
 * Single source of truth �?the immutable event store.
 * Read models (read_model.*) are projections; if a projection schema
 * needs to change, drop the projection table and replay events.
 *
 * stream_id is the aggregate id (e.g. order session id, run id).
 * (stream_id, seq) UNIQUE provides optimistic concurrency: if two writers
 * attempt seq=N+1, second wins via PG unique violation, retry from current state.
 */
export const events = domainSchema.table(
  'events',
  {
    id: pkUuid(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    streamType: varchar('stream_type', { length: 32 }).notNull(), // 'order' | 'run'
    streamId: uuid('stream_id').notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    type: varchar('type', { length: 64 }).notNull(),
    payload: jsonb('payload').notNull(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    correlationId: uuid('correlation_id'),
    causationId: uuid('causation_id'),
    /** Idempotency key from the originating command, if any. */
    idempotencyKey: varchar('idempotency_key', { length: 128 }),
  },
  (t) => ({
    streamSeqUnique: uniqueIndex('events_stream_seq_unique').on(t.streamId, t.seq),
    streamTypeIdx: index('events_stream_type_idx').on(t.streamType, t.occurredAt),
    correlationIdx: index('events_correlation_idx').on(t.correlationId),
    orgIdx: index('events_org_idx').on(t.orgId, t.occurredAt),
    typeOccurredIdx: index('events_type_occurred_idx').on(t.type, t.occurredAt),
  }),
);

/**
 * Optional snapshot at seq=N to avoid replaying long histories.
 * Workers periodically snapshot active streams.
 *
 * @deprecated (M1.18, 2026-05-08) — no worker currently writes to this
 * table. The replay path in `pnpm reproject` ignores snapshots and
 * folds from seq 0 every time, which is fine while streams stay short
 * (<200 events in practice). When run streams cross ~1000 events
 * we'll wire up a snapshotter; until then the table is structural
 * scaffolding only. The `purge-fake-data` and rls-isolation tests
 * still issue defensive DELETEs against it, so it stays in the
 * schema — dropping would require updating those call sites.
 */
export const snapshots = domainSchema.table(
  'snapshots',
  {
    streamId: uuid('stream_id').notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    state: jsonb('state').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: uniqueIndex('snapshots_stream_pk').on(t.streamId, t.seq),
    streamIdx: index('snapshots_stream_idx').on(t.streamId, t.seq),
  }),
);

/** Records every policy decision (sampled). Used for explainability + post-incident review. */
export const policyDecisions = domainSchema.table(
  'policy_decisions',
  {
    id: pkUuid(),
    orgId: uuid('org_id').notNull(),
    actorId: uuid('actor_id'),
    action: varchar('action', { length: 100 }).notNull(),
    resourceType: varchar('resource_type', { length: 64 }),
    resourceId: uuid('resource_id'),
    decision: varchar('decision', { length: 16 }).notNull(), // allow|deny
    reason: text('reason'),
    matchedRules: jsonb('matched_rules').default(sql`'[]'::jsonb`),
    inputs: jsonb('inputs'),
    /** B2 (2026-05-06): denormalized scope. The `auditAdmin` helper
     *  derives this from action input (storeId / scopeId / fromStoreId)
     *  when the action is store-scoped, NULL otherwise. Lets the
     *  audit-log query filter by store without parsing JSON.
     *  Migration: 0009. Old rows stay NULL — they predate the column. */
    scopeStoreId: uuid('scope_store_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    actorIdx: index('policy_dec_actor_idx').on(t.actorId, t.occurredAt),
    actionIdx: index('policy_dec_action_idx').on(t.action, t.occurredAt),
  }),
);

/** Generic per-stream cursor used by projector workers. */
export const projectorCursors = domainSchema.table('projector_cursors', {
  name: varchar('name', { length: 64 }).primaryKey(),
  lastEventId: uuid('last_event_id'),
  lastEventOccurredAt: timestamp('last_event_occurred_at', {
    withTimezone: true,
    mode: 'date',
  }),
  lag: integer('lag').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});
