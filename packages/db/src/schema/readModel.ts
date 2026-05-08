import { sql } from 'drizzle-orm';
import {
  bigint,
  date,
  decimal,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './auth';
import { stores, suppliers, skus } from './inventory';
import { readModelSchema } from './_helpers';

/**
 * Projection of order event streams, keyed (org, store, date).
 *
 * 2026-05-02 model change: a "session" is now PER-STORE, not per-member.
 * Multiple staff at the same store collaborate on ONE shopping list.
 * Each line item carries createdByMemberId / updatedByMemberId so we
 * know who put what in. The session-level submitter / claimer / decider
 * stays member-scoped (one person submits, one person approves).
 */
export const orderSessionsV = readModelSchema.table(
  'order_sessions_v',
  {
    id: uuid('id').primaryKey(), // matches stream_id
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    orderDate: date('order_date', { mode: 'string' }).notNull(),
    status: varchar('status', { length: 24 }).notNull(), // draft|submitted|approved|rejected|in_run|archived
    /** First member to add an item — convenience for "who started this". */
    initiatedByMemberId: uuid('initiated_by_member_id'),
    submittedByMemberId: uuid('submitted_by_member_id'),
    claimedByMemberId: uuid('claimed_by_member_id'),
    claimedAt: timestamp('claimed_at', { withTimezone: true, mode: 'date' }),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    decidedByMemberId: uuid('decided_by_member_id'),
    rejectReason: text('reject_reason'),
    runId: uuid('run_id'),
    /**
     * Free-text "其他物品" note (M1.8, 2026-05-07). Last-write-wins;
     * only the session owner can edit (same gate as line items). Null
     * when nothing has been written. Length cap enforced in the
     * domain layer (1000 chars).
     */
    notes: text('notes'),
    totalsJson: jsonb('totals_json').notNull().default(sql`'{}'::jsonb`),
    lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    /** Per-(org, store, member, date) — restored 0005 (2026-05-04) so
     *  each staff drafts + submits their own private order. */
    orgStoreMemberDateUnique: uniqueIndex('osv_org_store_member_date_unique').on(
      t.orgId,
      t.storeId,
      t.initiatedByMemberId,
      t.orderDate,
    ),
    orgStatusDateIdx: index('osv_org_status_date_idx').on(t.orgId, t.status, t.orderDate),
    runIdx: index('osv_run_idx').on(t.runId),
  }),
);

/**
 * Items in the per-store shared shopping list.
 *
 * Composite PK is `(session_id, sku_id, contributor_member_id)` —
 * each member gets their OWN row per SKU. Total qty for a SKU = sum
 * across all members' rows. This way two staff can independently say
 * "I need 3 apples" and "I need 2 apples" and the run gets 5, with no
 * one overwriting the other. Manager review (`order.approve`) can
 * still mutate any specific contributor row.
 */
export const orderItemsV = readModelSchema.table(
  'order_items_v',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => orderSessionsV.id, { onDelete: 'cascade' }),
    skuId: uuid('sku_id')
      .notNull()
      .references(() => skus.id, { onDelete: 'cascade' }),
    /** Member whose contribution this row represents. NOT NULL since 0002. */
    contributorMemberId: uuid('contributor_member_id').notNull(),
    qty: decimal('qty', { precision: 12, scale: 3 }).notNull().default('0'),
    note: text('note'),
    /** Member who last touched this row — usually the contributor, but a
     *  manager can edit it during review (per #6). */
    updatedByMemberId: uuid('updated_by_member_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sessionId, t.skuId, t.contributorMemberId] }),
    skuIdx: index('oiv_sku_idx').on(t.skuId),
    contributorIdx: index('oiv_contributor_idx').on(t.sessionId, t.contributorMemberId),
  }),
);

export const marketRunsV = readModelSchema.table(
  'market_runs_v',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    runDate: date('run_date', { mode: 'string' }).notNull(),
    runIndex: integer('run_index').notNull().default(0),
    status: varchar('status', { length: 24 }).notNull(), // planned|purchasing|delivering|finished|cancelled
    plannedTotal: decimal('planned_total', { precision: 14, scale: 2 }),
    actualTotal: decimal('actual_total', { precision: 14, scale: 2 }),
    /**
     * M1.14 (2026-05-08): cash / transfer breakdown of `actualTotal`.
     * Both nullable (NULL until FinishRun fires); writers backfill
     * legacy rows without payment-method tracking as `actualTotal` in
     * the cash bucket since transfers weren't recorded pre-M1.14.
     */
    actualCashTotal: decimal('actual_cash_total', { precision: 14, scale: 2 }),
    actualTransferTotal: decimal('actual_transfer_total', { precision: 14, scale: 2 }),
    purchaserMemberId: uuid('purchaser_member_id'),
    sessionIdsJson: jsonb('session_ids_json').notNull().default(sql`'[]'::jsonb`),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgDateIndexUnique: uniqueIndex('mrv_org_date_index_unique').on(
      t.orgId,
      t.runDate,
      t.runIndex,
    ),
    orgStatusIdx: index('mrv_org_status_idx').on(t.orgId, t.status, t.runDate),
  }),
);

export const runItemsV = readModelSchema.table(
  'run_items_v',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => marketRunsV.id, { onDelete: 'cascade' }),
    skuId: uuid('sku_id')
      .notNull()
      .references(() => skus.id, { onDelete: 'cascade' }),
    plannedQty: decimal('planned_qty', { precision: 12, scale: 3 }).notNull(),
    purchasedQty: decimal('purchased_qty', { precision: 12, scale: 3 }),
    supplierId: uuid('supplier_id').references(() => suppliers.id, { onDelete: 'set null' }),
    unitPrice: decimal('unit_price', { precision: 14, scale: 2 }),
    status: varchar('status', { length: 24 }).notNull().default('pending'), // pending|purchased|unavailable
    /**
     * M1.14 (2026-05-08): per-item payment method ('cash' | 'transfer').
     * Defaults to 'cash' so the migration can backfill existing rows
     * without breaking NOT NULL — historically all transactions were
     * effectively cash (transfers weren't tracked at all).
     */
    paymentMethod: varchar('payment_method', { length: 16 }).notNull().default('cash'),
    unavailableNote: text('unavailable_note'),
    receiptPhotoUrl: text('receipt_photo_url'),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.skuId] }),
    statusIdx: index('riv_status_idx').on(t.runId, t.status),
  }),
);

export const runItemStoresV = readModelSchema.table(
  'run_item_stores_v',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => marketRunsV.id, { onDelete: 'cascade' }),
    skuId: uuid('sku_id')
      .notNull()
      .references(() => skus.id, { onDelete: 'cascade' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    qty: decimal('qty', { precision: 12, scale: 3 }).notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
    deliveredByUserId: uuid('delivered_by_user_id').references(() => users.id),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true, mode: 'date' }),
    confirmedByUserId: uuid('confirmed_by_user_id').references(() => users.id),
    confirmStatus: varchar('confirm_status', { length: 16 }), // ok|short|wrong|quality
    confirmNote: text('confirm_note'),
    confirmPhotoUrl: text('confirm_photo_url'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.skuId, t.storeId] }),
    storeIdx: index('risv_store_idx').on(t.storeId, t.deliveredAt),
  }),
);
