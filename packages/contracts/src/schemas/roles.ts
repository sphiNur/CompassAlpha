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

/**
 * Store-manager threshold. Roles at or above this rank may record and
 * correct operating-expense details for the concrete store where the role is
 * effective. Keep this separate from ADMIN_RANK: a manager is store-tier,
 * not organization-tier.
 */
export const MANAGER_RANK = 60;
