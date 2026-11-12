/**
 * Shared role constants (M1.5, 2026-05-06).
 *
 * Single source of truth for the rank thresholds that both server
 * gates and FE filters use. Before this consolidation, `ADMIN_RANK =
 * 80` was duplicated as four inline literals — server (admin router),
 * FE (AdminPage GrantRoleSheet, ManualInviteSheet, store-tier filters)
 * — with at least one of them already labeled "Server-side
 * ADMIN_RANK threshold mirror". One careless edit and they'd drift.
 *
 * Add new rank-related constants here, not as inline literals.
 */

/**
 * Org-tier threshold. Roles with rank ≥ this are "org-tier" — they
 * apply globally and must be granted with `scopeType: 'global'`.
 * Roles below are "store-tier" — inherently per-store, must be
 * granted with `scopeType: 'store'` (server enforces, FE filters).
 *
 * Built-in mapping:
 *   super_admin = 100  (org-tier)
 *   admin       = 80   (org-tier; this is the threshold)
 *   manager     = 60   (store-tier)
 *   purchaser   = 40   (store-tier)
 *   cashier     = 30   (store-tier)
 *   staff       = 20   (store-tier)
 */
export const ADMIN_RANK = 80;

/** Highest built-in rank: super_admin may rename anyone (2026-10-21). */
export const SUPER_ADMIN_RANK = 100;

/**
 * Keys that mean authority over the whole organisation. Only a global role
 * binding or a global override yields them; the same key granted in one
 * store counts nowhere (storeScope.grantCounts in the API), and
 * memberPermissionSet refuses one in a store. Here since ADM1-07, so the
 * People screen leaves them out of a store's overrides.
 *
 * - `org.admin`: the organisation-admin marker.
 * - `dishes.manage` (review CONF-04, 2026-11-09): dishes and recipes are
 *   shared by every store, and each store's sales deduct stock by the same
 *   recipe. A store-level grant let one store change the menu, the recipes
 *   and the selling prices of all of them, which M3.2 took away from store
 *   managers on purpose.
 */
export const ORG_WIDE_PERMISSION_KEYS: ReadonlySet<string> = new Set([
  'org.admin',
  'dishes.manage',
]);
