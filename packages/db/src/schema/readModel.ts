import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
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
    /** Last force-released claimer (M3.22, 2026-05-18). Set when a
     *  ClaimReleased event lands with reason='override' or 'timeout',
     *  recording who was sitting on the order before they got bumped.
     *  Cleared on a clean self-release or any terminal status change
     *  so the banner only shows "X → Y" while the handoff is recent. */
    previousClaimerMemberId: uuid('previous_claimer_member_id'),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    decidedByMemberId: uuid('decided_by_member_id'),
    rejectReason: text('reject_reason'),
    runId: uuid('run_id'),
    /**
     * Free-text "其他物品" note (M1.8, 2026-05-07).
     *
     * M3.16-C (2026-05-16): superseded by `extrasJson` below. The
     * column is retained for backwards-compat reads of pre-M3.16
     * sessions; new writes go through extrasJson and downstream
     * pages render the structured list. Drop once no live sessions
     * have a non-null `notes` value.
     */
    notes: text('notes'),
    /**
     * Structured "其他物品" line items (M3.16-C, 2026-05-16). Array
     * of { name, qty, unit, note? } objects. Default '[]'::jsonb.
     * Last-write-wins on the whole array — there is no per-item
     * event; SessionExtrasSet overwrites the list atomically.
     */
    extrasJson: jsonb('extras_json').notNull().default(sql`'[]'::jsonb`),
    totalsJson: jsonb('totals_json').notNull().default(sql`'{}'::jsonb`),
    lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    /** M3.32 (2026-05-18): the historical unique was unconditional —
     *  one row per (member, store, date) across ALL statuses. Migration
     *  0026 rewrites it to be partial: at most one ROW IN DRAFT STATUS
     *  per (member, store, date). Once the staff submits, the row's
     *  status moves off 'draft', so a brand-new draft for the same
     *  (member, store, date) can be created — enabling the multi-
     *  batch-per-day workflow the user asked for in the architectural
     *  review (Q3). Submitted/approved/rejected/in_run rows accumulate
     *  unbounded; run.previewCreatable aggregates whatever's approved.
     */
    orgStoreMemberDateDraftUnique: uniqueIndex('osv_org_store_member_date_draft_unique')
      .on(t.orgId, t.storeId, t.initiatedByMemberId, t.orderDate)
      .where(sql`status = 'draft'`),
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
    /**
     * Run-level claim — C.2 (M3.38, 2026-05-19). Mirrors the
     * order-session claim shape from M3.19 + M3.22. Set on RunClaimed,
     * cleared on RunClaimReleased / RunFinished / RunCancelled.
     */
    claimedByMemberId: uuid('claimed_by_member_id'),
    claimedAt: timestamp('claimed_at', { withTimezone: true, mode: 'date' }),
    /** Snapshot of last forcibly-released claimer (override / timeout). */
    previousClaimerMemberId: uuid('previous_claimer_member_id'),
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
    /** Partial index for the worker's stale-claim sweep. */
    claimedIdx: index('mrv_claimed_idx')
      .on(t.claimedAt)
      .where(sql`claimed_by_member_id IS NOT NULL`),
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
    /**
     * M3.41 (2026-05-21): true when the purchaser added this row
     * mid-run (PurchaserItemAdded event) rather than the row coming
     * from the original aggregated demand. Lets finish-summary and
     * audit reports separate "ordered" vs "added beyond the ask".
     * Default false matches the legacy data — every pre-M3.41 row
     * came from RunPlanned or SessionsAttachedToRun.
     */
    addedByPurchaser: boolean('added_by_purchaser').notNull().default(false),
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
