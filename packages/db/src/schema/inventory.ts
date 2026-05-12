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
