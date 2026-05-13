import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { organizations } from './auth';
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
    names: jsonb('names').notNull().default(sql`'{}'::jsonb`),
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
    names: jsonb('names').notNull().default(sql`'{}'::jsonb`),
    /** i18n search aliases (added 0006). Shape: { zh: [...], ru: [...], ... }
     *  Powers OrderPage fuzzy search so "纸" matches every packaging paper. */
    aliases: jsonb('aliases').notNull().default(sql`'{}'::jsonb`),
    /** i18n purchase notes (added 0006). Shape: { zh: "...", en: "...", ... }
     *  e.g. "按整包,通常 10 支" for `Sasiska (pochka)`. */
    description: jsonb('description').notNull().default(sql`'{}'::jsonb`),
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
    names: jsonb('names').notNull().default(sql`'{}'::jsonb`),
    description: jsonb('description').notNull().default(sql`'{}'::jsonb`),
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
