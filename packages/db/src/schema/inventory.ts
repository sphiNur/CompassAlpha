import { sql } from 'drizzle-orm';
import {
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
import { members, organizations } from './auth';
import { createdAt, deletedAt, inventorySchema, pkUuid, updatedAt } from './_helpers';

export const stores = inventorySchema.table(
  'stores',
  {
    id: pkUuid(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(),
    code: varchar('code', { length: 32 }),
    address: text('address'),
    geoLat: decimal('geo_lat', { precision: 9, scale: 6 }),
    geoLng: decimal('geo_lng', { precision: 9, scale: 6 }),
    timezone: varchar('timezone', { length: 64 }),
    sortIndex: integer('sort_index').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    /** D3 (2026-05-06): default role for members invited into this
     *  store when no role is explicitly picked. Nullable. The invite
     *  path falls back to this when `input.roleSlug` is blank and the
     *  store has it set; otherwise the new member gets no role and
     *  the operator can grant one later. ON DELETE SET NULL so role
     *  deletion doesn't break the store row (see migration 0009). */
    defaultRoleId: uuid('default_role_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => ({
    orgIdx: index('stores_org_idx').on(t.orgId),
    orgCodeUnique: uniqueIndex('stores_org_code_unique').on(t.orgId, t.code),
  }),
);

/**
 * JSONB shapes stored on a daily close. They deliberately duplicate the
 * contract's shape so @compass/db remains independent of @compass/contracts.
 * The API validates every value before it can reach these columns.
 */
export type StoreDailySettlementOperatingExpenseItem = {
  category: 'supplies' | 'utilities' | 'transport' | 'maintenance' | 'rent' | 'other';
  item: string;
  amount: string;
  paidTo: string | null;
  reason: string;
};

export type StoreDailySettlementWageItem = {
  personName: string;
  status: 'paid' | 'unpaid';
  amount: string;
  reason: string;
};

/**
 * One closing record per store and business date.
 *
 * This is an operational ledger, not a tax-concealment mechanism. The
 * `cashOnHand` field records physical cash left in the till/safe after
 * close; every create/update is attributed to a member and the API also
 * writes an update-protected audit snapshot to `storeDailySettlementRevisions`.
 */
export const storeDailySettlements = inventorySchema.table(
  'store_daily_settlements',
  {
    id: pkUuid(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    settlementDate: date('settlement_date', { mode: 'string' }).notNull(),

    /** Card/transfer/QR receipts visible on the bank statement. */
    onlineRevenue: decimal('online_revenue', { precision: 14, scale: 2 }).notNull().default('0'),
    /** Cash received from customers for invoiced/fiscalized sales. */
    invoicedCashRevenue: decimal('invoiced_cash_revenue', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),
    operatingExpenses: decimal('operating_expenses', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),
    wagesPaid: decimal('wages_paid', { precision: 14, scale: 2 }).notNull().default('0'),
    wagesAccrued: decimal('wages_accrued', { precision: 14, scale: 2 }).notNull().default('0'),
    /** Itemized operating outflows; the API derives operatingExpenses from these rows. */
    operatingExpenseItems: jsonb('operating_expense_items')
      .$type<StoreDailySettlementOperatingExpenseItem[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Per-person paid/unpaid wage rows; the API derives both wage totals. */
    wageItems: jsonb('wage_items')
      .$type<StoreDailySettlementWageItem[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    nextPurchaseReserve: decimal('next_purchase_reserve', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),
    /** Signed: positive = store still owes procurement; negative = surplus/credit. */
    priorPurchaseAdjustment: decimal('prior_purchase_adjustment', {
      precision: 14,
      scale: 2,
    })
      .notNull()
      .default('0'),
    /** Physical cash remaining after the daily close. */
    cashOnHand: decimal('cash_on_hand', { precision: 14, scale: 2 }).notNull().default('0'),
    note: text('note'),

    /** Optimistic concurrency token; incremented on every successful save. */
    version: integer('version').notNull().default(1),
    createdByMemberId: uuid('created_by_member_id').references(() => members.id, {
      onDelete: 'set null',
    }),
    updatedByMemberId: uuid('updated_by_member_id').references(() => members.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    orgStoreDateUnique: uniqueIndex('sds_org_store_date_unique').on(
      t.orgId,
      t.storeId,
      t.settlementDate,
    ),
    orgDateIdx: index('sds_org_date_idx').on(t.orgId, t.settlementDate),
    storeDateIdx: index('sds_store_date_idx').on(t.storeId, t.settlementDate),
  }),
);

/**
 * Append-only snapshots for every daily-settlement save. There is no API
 * mutation that updates or deletes these rows: corrections create a new
 * settlement version and a matching revision in the same transaction.
 */
export const storeDailySettlementRevisions = inventorySchema.table(
  'store_daily_settlement_revisions',
  {
    id: pkUuid(),
    settlementId: uuid('settlement_id')
      .notNull()
      .references(() => storeDailySettlements.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    settlementDate: date('settlement_date', { mode: 'string' }).notNull(),
    version: integer('version').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    changedFields: jsonb('changed_fields')
      .notNull()
      .default(sql`'[]'::jsonb`),
    correctionReason: text('correction_reason'),
    /** Deliberately not an FK: audit actor identity survives member removal. */
    actorMemberId: uuid('actor_member_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    settlementVersionUnique: uniqueIndex('sdsr_settlement_version_unique').on(
      t.settlementId,
      t.version,
    ),
    orgDateIdx: index('sdsr_org_date_idx').on(t.orgId, t.settlementDate),
    storeDateIdx: index('sdsr_store_date_idx').on(t.storeId, t.settlementDate),
  }),
);

/**
 * Supplier replaces Beta's `Stall`. Carries automated trust signals so
 * purchasers can pick informed defaults.
 */
export const suppliers = inventorySchema.table(
  'suppliers',
  {
    id: pkUuid(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(),
    contactPhone: varchar('contact_phone', { length: 32 }),
    contactTg: varchar('contact_tg', { length: 64 }),
    address: text('address'),
    photoUrl: text('photo_url'),
    rating: decimal('rating', { precision: 3, scale: 2 }), // user-provided 1.00-5.00
    reliabilityScore: decimal('reliability_score', { precision: 5, scale: 2 }).default('100.00'), // 0-100, auto
    priceTrustScore: decimal('price_trust_score', { precision: 5, scale: 2 }).default('100.00'), // 0-100, auto
    notes: text('notes'),
    isArchived: boolean('is_archived').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    orgIdx: index('suppliers_org_idx').on(t.orgId),
    orgNameIdx: index('suppliers_org_name_idx').on(t.orgId, t.name),
  }),
);

/** Per-store supplier preference order. */
export const storeSupplierPrefs = inventorySchema.table(
  'store_supplier_prefs',
  {
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'cascade' }),
    rank: integer('rank').notNull().default(100),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.storeId, t.supplierId] }),
    rankIdx: index('ssp_rank_idx').on(t.storeId, t.rank),
  }),
);

export const categories = inventorySchema.table(
  'categories',
  {
    id: pkUuid(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 64 }).notNull(),
    /** i18n names: { zh: '...', en: '...', ru: '...', uz: '...' } */
    names: jsonb('names')
      .notNull()
      .default(sql`'{}'::jsonb`),
    sortIndex: integer('sort_index').notNull().default(0),
    icon: varchar('icon', { length: 64 }),
    isArchived: boolean('is_archived').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    orgSlugUnique: uniqueIndex('categories_org_slug_unique').on(t.orgId, t.slug),
  }),
);

export const skus = inventorySchema.table(
  'skus',
  {
    id: pkUuid(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
    code: varchar('code', { length: 64 }), // optional internal code
    /** i18n names */
    names: jsonb('names')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** i18n search aliases (added 0006). Shape: { zh: [...], ru: [...], ... }
     *  Powers OrderPage fuzzy search so "纸" matches every packaging paper. */
    aliases: jsonb('aliases')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** i18n purchase notes (added 0006). Shape: { zh: "...", en: "...", ... }
     *  e.g. "按整包,通常 10 支" for `Sasiska (pochka)`. */
    description: jsonb('description')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Unit string (kg, g, L, ml, pcs, pack, pair, bunch, roll). Display
     *  only; step controls UX granularity. */
    unit: varchar('unit', { length: 16 }).notNull(),
    step: decimal('step', { precision: 10, scale: 3 }).notNull().default('1'),
    imageUrl: text('image_url'),
    /** Suggested ordering quantity from historical data (auto-updated by worker). */
    suggestedQty: decimal('suggested_qty', { precision: 12, scale: 3 }),
    /**
     * M1.17: per-SKU tax rate override. NULL means "use org default
     * (auth.organizations.tax_rate_pct)". Most SKUs leave this null;
     * only items with a non-standard rate (e.g. exempt categories
     * like raw produce in some jurisdictions) get a value here.
     * Foundation only — not consumed by reports yet.
     */
    taxRatePct: decimal('tax_rate_pct', { precision: 5, scale: 2 }),
    sortIndex: integer('sort_index').notNull().default(0),
    isArchived: boolean('is_archived').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    orgIdx: index('skus_org_idx').on(t.orgId),
    orgCategoryIdx: index('skus_org_category_idx').on(t.orgId, t.categoryId),
    orgCodeUnique: uniqueIndex('skus_org_code_unique').on(t.orgId, t.code),
  }),
);

/**
 * Org-level expense templates (M3.57, 2026-05-23).
 *
 * Each row is a recurring off-catalog expense the chain incurs on
 * every run (e.g., porter / 装卸费, taxi, parking). Admin maintains
 * the list; `run.create` reads it and auto-emits one
 * `RunExpenseAdded` event per non-archived template so the
 * purchaser starts every new run with the standard charges already
 * staged — they just confirm or correct, no manual re-entry.
 *
 * Distinct from `run_expenses_v` (the per-run rows): templates are
 * the BLUEPRINT, expenses_v rows are the INSTANCES. Once attached,
 * an expense lives entirely on the run — editing a template later
 * does not retroactively rewrite past runs. Archiving a template
 * only stops it from being auto-attached to FUTURE runs.
 *
 * default_unit_price is mandatory (> 0). For variable-amount
 * expenses (taxi varies day to day) set a typical amount as the
 * default; the purchaser revises at run time if it diverges.
 */
export const expenseTemplates = inventorySchema.table(
  'expense_templates',
  {
    id: pkUuid(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    label: varchar('label', { length: 200 }).notNull(),
    /** Optional unit hint ("trip", "次"). Carried onto the expense row. */
    unitHint: varchar('unit_hint', { length: 32 }),
    defaultQty: decimal('default_qty', { precision: 12, scale: 3 }).notNull().default('1'),
    defaultUnitPrice: decimal('default_unit_price', {
      precision: 14,
      scale: 2,
    }).notNull(),
    /** 'cash' | 'transfer'. CHECK constraint in migration. */
    defaultPaymentMethod: varchar('default_payment_method', { length: 16 })
      .notNull()
      .default('cash'),
    sortIndex: integer('sort_index').notNull().default(0),
    isArchived: boolean('is_archived').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    orgActiveIdx: index('expense_templates_org_active_idx').on(t.orgId, t.sortIndex, t.createdAt),
  }),
);

/** Default supplier(s) for a SKU + last-seen prices. */
export const skuSupplierLinks = inventorySchema.table(
  'sku_supplier_links',
  {
    skuId: uuid('sku_id')
      .notNull()
      .references(() => skus.id, { onDelete: 'cascade' }),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'cascade' }),
    defaultPrice: decimal('default_price', { precision: 14, scale: 2 }),
    lastSeenPrice: decimal('last_seen_price', { precision: 14, scale: 2 }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }),
    isPreferred: boolean('is_preferred').notNull().default(false),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.skuId, t.supplierId] }),
    supplierIdx: index('ssl_supplier_idx').on(t.supplierId),
  }),
);

/**
 * Dishes (M2.0b, 2026-05-08) — the menu items the kitchen sells.
 *
 * Schema parallels `skus`:
 *   - per-org (one menu per tenant)
 *   - i18n names + optional code for quick reference
 *   - sort_index for ordering on the sales-entry UI
 *   - is_archived rather than hard-delete (sales history references)
 *
 * Optional `unitPrice` is the SELLING price per serving (UZS / org
 * currency, see auth.organizations.currency). Used later by sales-
 * recording flows to compute revenue; not strictly required for the
 * BOM-driven consumption logic (which only needs the ingredient
 * weights).
 *
 * Recipe = the rows in `dish_ingredients` linking this dish to one or
 * more SKUs, each with a `qty_per_serving`. M2.0c will read those to
 * write inventory.movements rows on sale.
 */
export const dishes = inventorySchema.table(
  'dishes',
  {
    id: pkUuid(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    code: varchar('code', { length: 32 }),
    names: jsonb('names')
      .notNull()
      .default(sql`'{}'::jsonb`),
    description: jsonb('description')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Selling price per serving in the org's currency. Optional. */
    unitPrice: decimal('unit_price', { precision: 14, scale: 2 }),
    sortIndex: integer('sort_index').notNull().default(0),
    isArchived: boolean('is_archived').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    orgIdx: index('dishes_org_idx').on(t.orgId, t.isArchived),
    orgCodeUnique: uniqueIndex('dishes_org_code_unique').on(t.orgId, t.code),
  }),
);

/**
 * Recipe / Bill-of-Materials rows. One row per (dish, ingredient SKU).
 *
 * `qtyPerServing` is in the SKU's native unit (kg / pcs / L / pack /
 * etc.) and represents how much of that SKU one serving consumes. The
 * decimal precision (12,4) gives 0.0001-unit resolution — enough for
 * "5 g of salt = 0.0050 kg" type recipes without using exponent
 * notation.
 *
 * Optional `note` captures cooking-context hints ("after marinating",
 * "trim outer leaves") that don't change the math but help kitchen
 * staff sanity-check the BOM at edit time.
 *
 * Primary key is (dish_id, sku_id). A dish can have at most one row
 * per ingredient — if the same SKU appears twice in a recipe (e.g.
 * "salt in the rub AND salt in the sauce"), the operator sums those
 * into a single line.
 *
 * CASCADE on dish delete (drops the recipe with the dish);
 * RESTRICT-equivalent on SKU delete via `set null` reference would
 * orphan rows, so we use cascade there too — archiving a SKU that's
 * still in a recipe should warn the operator instead, which the
 * router enforces.
 */
export const dishIngredients = inventorySchema.table(
  'dish_ingredients',
  {
    dishId: uuid('dish_id')
      .notNull()
      .references(() => dishes.id, { onDelete: 'cascade' }),
    skuId: uuid('sku_id')
      .notNull()
      .references(() => skus.id, { onDelete: 'cascade' }),
    qtyPerServing: decimal('qty_per_serving', { precision: 12, scale: 4 }).notNull(),
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.dishId, t.skuId] }),
    skuIdx: index('dish_ing_sku_idx').on(t.skuId),
  }),
);

/**
 * Sales (M2.0c, 2026-05-08) — recorded dish sales per store.
 *
 * One row per "we sold N portions of dish X at store Y" event. The
 * server, in the same tx that inserts the sales row, also writes
 * inventory.movements rows (one per ingredient in the dish's recipe)
 * with delta = -(qty × qty_per_serving) and reason='consumption'.
 *
 * This closes the ERP loop: purchase → receive (M2.0a) → menu+BOM
 * (M2.0b) → consume (M2.0c).
 *
 * Source linkage:
 *   The auto-emitted movement rows carry sourceType='sale' +
 *   sourceId=<sales.id>. The partial UNIQUE index on movements
 *   (source_type, source_id, store_id, sku_id) guarantees that a
 *   replay or double-fire of `sales.record` cannot double-deduct.
 *
 * Editing / deleting (NOT in M2.0c):
 *   First cut is record-only. Mistakes are corrected via the
 *   stocktake action (M2.0a). M2.x can add `sales.delete` that
 *   soft-marks the row AND writes reversal movements with reason=
 *   'consumption_reversed' so the audit trail stays append-only.
 *   For now `sales.delete` doesn't exist — keep it simple.
 *
 * Price snapshot:
 *   `unit_price` on the sale row is the SELLING price per serving
 *   *at sale time*. Snapshotted (not joined from dishes.unitPrice)
 *   so future price changes don't retroactively rewrite past
 *   revenue. M2.x can roll these into a per-day revenue report.
 */
export const sales = inventorySchema.table(
  'sales',
  {
    id: pkUuid(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    dishId: uuid('dish_id')
      .notNull()
      .references(() => dishes.id, { onDelete: 'restrict' }),
    /**
     * Number of servings sold in this single event. > 0.
     *
     * M1.20 (2026-05-08): widened from (10, 2) → (12, 3) via migration
     * 0018 to match every other qty column in the schema. The original
     * narrower precision silently truncated the 3rd-decimal during the
     * BOM-multiplication step in `sales.record`, causing the sales row
     * to disagree with the inventory.movements rows it emits.
     */
    qty: decimal('qty', { precision: 12, scale: 3 }).notNull(),
    /** Selling price per serving at sale time. NULL if the dish had
     *  no price set when sold (we still record the consumption). */
    unitPrice: decimal('unit_price', { precision: 14, scale: 2 }),
    /** Who logged it — for audit / shift reconciliation. */
    recordedByMemberId: uuid('recorded_by_member_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    createdAt: createdAt(),
  },
  (t) => ({
    storeTimeIdx: index('sales_store_time_idx').on(t.storeId, t.occurredAt),
    orgTimeIdx: index('sales_org_time_idx').on(t.orgId, t.occurredAt),
    dishIdx: index('sales_dish_idx').on(t.dishId, t.occurredAt),
  }),
);

/**
 * Inventory ledger — every quantity change for a (store, SKU) lands
 * here as an immutable row. Current on-hand = SUM(delta) per pair.
 * Added M2.0a (2026-05-08): the first step of the ERP shift. Unlike
 * the Order / Run aggregates, inventory is NOT event-sourced — it
 * doesn't have meaningful state-machine transitions to guard. Append-
 * only ledger + view-based aggregation is the right model for a
 * book-of-deltas like this.
 *
 * Movement sources:
 *   - 'delivery_received': auto-emitted when a run's StoreConfirmed
 *     event lands. delta = +received qty per (store, sku).
 *   - 'stocktake': manual absolute correction — operator counts the
 *     shelf, types the actual qty, the system writes a delta to make
 *     SUM equal that target. Reason field captures any note.
 *   - 'wastage': manual subtraction with an explanation (spoiled,
 *     broken, mislabeled). delta is negative.
 *   - 'consumption': auto-emitted from M2.0c sales when a dish
 *     order resolves into ingredient consumption via the BOM.
 *   - 'transfer_in' / 'transfer_out': inter-store movement
 *     (M2.x — pairs of rows, same magnitude, opposite signs).
 *   - 'adjustment': catch-all for cases that don't fit above.
 *
 * `sourceType` + `sourceId` link back to the action that caused the
 * movement (e.g. sourceType='run', sourceId=<runId>). Lets the FE
 * say "this +5 kg came from run #42 on 2026-05-08".
 *
 * NOT scoped: cost basis. Inventory tracks QUANTITY only. Money
 * stays in run_items / run_item_stores. If COGS reporting later
 * needs unit cost at consumption time, M2.x will snapshot it onto
 * the movement row (FIFO vs. weighted-average is a follow-up
 * decision for that milestone).
 */
export const inventoryMovements = inventorySchema.table(
  'movements',
  {
    id: pkUuid(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    skuId: uuid('sku_id')
      .notNull()
      .references(() => skus.id, { onDelete: 'cascade' }),
    /** Signed quantity change. Positive = received, negative = consumed. */
    delta: decimal('delta', { precision: 12, scale: 3 }).notNull(),
    /** One of delivery_received | stocktake | wastage | consumption |
     *  transfer_in | transfer_out | adjustment. Validated in app code;
     *  kept as varchar for schema flexibility (no enum rebuild on add). */
    reason: varchar('reason', { length: 32 }).notNull(),
    /** Optional free-text note. Required when reason='wastage'. */
    note: text('note'),
    /** What domain entity caused this — 'run' / 'sale' / 'manual' / etc. */
    sourceType: varchar('source_type', { length: 32 }),
    /** ID of the entity above. Nullable for 'manual' rows. */
    sourceId: uuid('source_id'),
    /** Who triggered the movement (member, for audit). */
    actorMemberId: uuid('actor_member_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    createdAt: createdAt(),
  },
  (t) => ({
    storeSkuIdx: index('inv_mov_store_sku_idx').on(t.storeId, t.skuId, t.occurredAt),
    orgTimeIdx: index('inv_mov_org_time_idx').on(t.orgId, t.occurredAt),
    sourceIdx: index('inv_mov_source_idx').on(t.sourceType, t.sourceId),
    // Idempotency: a single (sourceType, sourceId, storeId, skuId)
    // never produces two rows. Lets us safely re-run the auto-receive
    // hook on StoreConfirmed without double-counting if a projection
    // replay re-fires the event.
    sourceUnique: uniqueIndex('inv_mov_source_unique')
      .on(t.sourceType, t.sourceId, t.storeId, t.skuId)
      .where(sql`source_type IS NOT NULL AND source_id IS NOT NULL`),
  }),
);

/** Insert-only price observations. Powers trends, alerts, supplier scoring. */
export const priceHistory = inventorySchema.table(
  'price_history',
  {
    id: pkUuid(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    skuId: uuid('sku_id')
      .notNull()
      .references(() => skus.id, { onDelete: 'cascade' }),
    supplierId: uuid('supplier_id').references(() => suppliers.id, { onDelete: 'set null' }),
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'set null' }),
    runId: uuid('run_id'),
    unitPrice: decimal('unit_price', { precision: 14, scale: 2 }).notNull(),
    qty: decimal('qty', { precision: 12, scale: 3 }).notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    createdAt: createdAt(),
  },
  (t) => ({
    skuIdx: index('price_hist_sku_idx').on(t.skuId, t.observedAt),
    orgIdx: index('price_hist_org_idx').on(t.orgId, t.observedAt),
    supplierIdx: index('price_hist_supplier_idx').on(t.supplierId, t.observedAt),
  }),
);
