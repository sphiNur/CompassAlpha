import { sql } from 'drizzle-orm';
import {
  bigint,
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
import { authSchema, createdAt, deletedAt, pkUuid, updatedAt } from './_helpers';

/** Tenant boundary. */
export const organizations = authSchema.table(
  'organizations',
  {
    id: pkUuid(),
    slug: varchar('slug', { length: 64 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    plan: varchar('plan', { length: 32 }).notNull().default('free'),
    localeDefault: varchar('locale_default', { length: 16 }).notNull().default('en'),
    /**
     * IANA timezone (e.g. 'Asia/Tashkent', 'Europe/Moscow'). Drives the
     * "today's date" key used to bucket orders / runs / daily reports.
     * Default 'Asia/Tashkent' as of D.1 (M3.39, 2026-05-20) — the
     * launch tenant lives in UZ; the prior 'UTC' default silently
     * rolled the day boundary at 5am local. Migration 0028 backfilled
     * existing UTC-defaulted rows.
     */
    timezone: varchar('timezone', { length: 64 }).notNull().default('Asia/Tashkent'),
    /**
     * M1.17 (2026-05-08) — financial foundation columns:
     *
     *   `currency` is the ISO-4217 code (3 letters) every money column
     *   in this org's data is denominated in. Default 'UZS' matches
     *   the launch market. The FE reads this from session and feeds
     *   it to `formatMoney(value, currency)` so adding a second
     *   tenant in KZT / RUB doesn't require code changes. Money
     *   columns are NOT re-denominated when this changes — operators
     *   should NEVER flip it mid-life; the column exists to scope
     *   per-tenant defaults, not to support multi-currency books.
     *
     *   `taxRatePct` is the org-wide default VAT applied to purchase
     *   prices. Default 0 (opt-in). Uzbekistan's standard VAT is 12;
     *   most other markets sit between 5-25. SKU-level override lives
     *   on `inventory.skus.tax_rate_pct`.
     *
     *   `pricesIncludeTax` declares whether unit_price values stored
     *   in run_items already include the tax (gross) or are pre-tax
     *   (net). Default true matches the typical "merchant quotes the
     *   gross price at the stall" workflow. Reports use this flag to
     *   surface the recoverable VAT slice without writing it as a
     *   separate column (no historical-revision risk).
     *
     * None of these fields participate in the financial domain yet —
     * M1.17 is foundation only. M2.x will capture tax_rate at
     * transaction time so historical rate changes don't retroactively
     * rewrite past purchases.
     */
    currency: varchar('currency', { length: 3 }).notNull().default('UZS'),
    taxRatePct: decimal('tax_rate_pct', { precision: 5, scale: 2 }).notNull().default('0'),
    pricesIncludeTax: boolean('prices_include_tax').notNull().default(true),
    workflow: jsonb('workflow').notNull().default(sql`'{}'::jsonb`),
    featureFlags: jsonb('feature_flags').notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => ({
    slugUnique: uniqueIndex('organizations_slug_unique').on(t.slug),
  }),
);

/** Identity. A user may belong to multiple orgs via `members`. */
export const users = authSchema.table(
  'users',
  {
    id: pkUuid(),
    tgUserId: bigint('tg_user_id', { mode: 'bigint' }),
    tgUsername: varchar('tg_username', { length: 64 }),
    email: varchar('email', { length: 200 }),
    displayName: varchar('display_name', { length: 200 }).notNull(),
    avatarUrl: text('avatar_url'),
    locale: varchar('locale', { length: 16 }),
    /** True once the user has confirmed their displayName via the
     *  onboarding flow. After that, only an admin (`users.manage`) can
     *  change it — the user themselves cannot. False for fresh sign-ups
     *  and for placeholders created by `admin.memberInviteByTgId`. */
    displayNameLocked: boolean('display_name_locked').notNull().default(false),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => ({
    tgUserIdUnique: uniqueIndex('users_tg_user_id_unique').on(t.tgUserId),
    emailUnique: uniqueIndex('users_email_unique').on(t.email),
  }),
);

export const members = authSchema.table(
  'members',
  {
    id: pkUuid(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 16 }).notNull().default('active'), // active|invited|suspended
    invitedBy: uuid('invited_by').references(() => users.id),
    joinedAt: timestamp('joined_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    orgUserUnique: uniqueIndex('members_org_user_unique').on(t.orgId, t.userId),
    orgIdx: index('members_org_idx').on(t.orgId),
  }),
);

/**
 * Per-store assignment for a member. A member MUST be assigned to at
 * least one store before they can edit/view that store's orders. The
 * mapping is many-to-many — a member can be assigned to multiple stores
 * (e.g. a regional manager covering 3 stores).
 *
 * Server-side enforcement lives in `assertActorAssignedToStore` (apps/
 * api/src/services/storeScope.ts) which is called from every order /
 * delivery mutation that takes a `storeId`. Bypass paths:
 *   - Members with `users.manage` permission (admin / super_admin) skip
 *     the check; they can poke any store in the org for ops purposes.
 *   - Aggregate views like the purchaser's run cockpit don't check
 *     here — they're already gated on `run.purchase` permission.
 */
export const memberStoreAssignments = authSchema.table(
  'member_store_assignments',
  {
    memberId: uuid('member_id').notNull(),
    storeId: uuid('store_id').notNull(),
    assignedAt: timestamp('assigned_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    assignedBy: uuid('assigned_by'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.memberId, t.storeId] }),
    memberIdx: index('msa_member_idx').on(t.memberId),
    storeIdx: index('msa_store_idx').on(t.storeId),
  }),
);

export const roles = authSchema.table(
  'roles',
  {
    id: pkUuid(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    slug: varchar('slug', { length: 64 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    description: text('description'),
    isBuiltIn: boolean('is_built_in').notNull().default(false),
    /**
     * Numeric rank used to enforce "no equal/higher grants" (added
     * 2026-05-03). The ABAC rule is: an actor can only grant a role
     * whose rank is STRICTLY LESS than the highest rank the actor
     * holds. So an admin (rank 80) can grant manager (60) or staff
     * (20), but NOT another admin (80) and never super_admin (100).
     *
     * Built-in ranks (seed):
     *   100 super_admin   — platform tenant admin (Compass team)
     *    80 admin         — workspace owner
     *    60 manager       — store manager (approves orders)
     *    40 purchaser     — runs the market run
     *    20 staff         — front-of-house team
     *
     * Custom roles created by an admin live in the gaps (e.g. 50 for
     * "shift lead" between purchaser and manager). Higher number =
     * more powerful.
     */
    rank: integer('rank').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => ({
    orgSlugUnique: uniqueIndex('roles_org_slug_unique').on(t.orgId, t.slug),
  }),
);

/**
 * Permissions are a global static dictionary �?one row per `(domain, action)`,
 * e.g. `order.adjust`, `run.create`. Roles bind to a subset; policies layer on top.
 */
export const permissions = authSchema.table(
  'permissions',
  {
    key: varchar('key', { length: 100 }).primaryKey(),
    description: text('description'),
  },
);

export const rolePermissions = authSchema.table(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionKey: varchar('permission_key', { length: 100 })
      .notNull()
      .references(() => permissions.key, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.roleId, t.permissionKey] }),
  }),
);

/** A member's role binding. `scopeType` �?('global','store') controls reach. */
export const memberRoleBindings = authSchema.table(
  'member_role_bindings',
  {
    id: pkUuid(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    scopeType: varchar('scope_type', { length: 16 }).notNull().default('global'),
    scopeId: uuid('scope_id'), // nullable when scopeType='global'
    grantedBy: uuid('granted_by').references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => ({
    memberIdx: index('mrb_member_idx').on(t.memberId),
    roleIdx: index('mrb_role_idx').on(t.roleId),
  }),
);

/**
 * Per-member permission overrides (added 2026-05-05, migration 0008).
 *
 * Layers on top of role-derived permissions:
 *   - 'allow' — adds a permission key the role didn't grant
 *   - 'deny'  — removes a key the role would have granted
 *
 * Resolution at session-build:
 *   final = (union of role keys) ∪ (allow overrides) − (deny overrides)
 *
 * `scope` is global by default. Store-scoped overrides are written
 * here too but the M0 session payload still flattens to a single
 * permission set per session — per-store enforcement lands when the
 * store-context middleware grows. The schema is forward-compatible.
 */
export const memberPermissionOverrides = authSchema.table(
  'member_permission_overrides',
  {
    id: pkUuid(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    permissionKey: varchar('permission_key', { length: 100 })
      .notNull()
      .references(() => permissions.key, { onDelete: 'cascade' }),
    /** 'allow' | 'deny'. Deny beats allow on conflict. */
    effect: varchar('effect', { length: 8 }).notNull(),
    /** 'global' | 'store'. Mirrors member_role_bindings. */
    scopeType: varchar('scope_type', { length: 16 }).notNull().default('global'),
    /** Required when scope_type='store', NULL otherwise (DB CHECK). */
    scopeId: uuid('scope_id'),
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => ({
    memberIdx: index('mpo_member_idx').on(t.memberId),
    permIdx: index('mpo_perm_idx').on(t.permissionKey),
    // Note: the (member, permission, scope) uniqueness lives in the
    // SQL migration as a functional index using COALESCE on scope_id
    // because Postgres treats NULL as distinct in plain UNIQUE.
  }),
);

/**
 * ABAC overlay. Each rule is evaluated by the policy engine after RBAC
 * derives a baseline. `effect` is allow|deny; deny wins ties.
 */
export const policyRules = authSchema.table(
  'policy_rules',
  {
    id: pkUuid(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    description: text('description'),
    subjectExpr: text('subject_expr').notNull(), // e.g. "role == 'manager'"
    action: varchar('action', { length: 100 }).notNull(),
    resourceExpr: text('resource_expr').notNull(), // e.g. "session.storeId == subject.storeId"
    effect: varchar('effect', { length: 8 }).notNull(), // allow|deny
    priority: integer('priority').notNull().default(100),
    createdAt: createdAt(),
  },
  (t) => ({
    orgActionIdx: index('policy_org_action_idx').on(t.orgId, t.action),
  }),
);

/** Refresh tokens (rotating). */
export const refreshTokens = authSchema.table(
  'refresh_tokens',
  {
    id: pkUuid(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    family: uuid('family').notNull(), // rotation chain id
    parentId: uuid('parent_id'),
    userAgent: text('user_agent'),
    ip: varchar('ip', { length: 64 }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    tokenHashUnique: uniqueIndex('refresh_token_hash_unique').on(t.tokenHash),
    familyIdx: index('refresh_token_family_idx').on(t.family),
    userIdx: index('refresh_token_user_idx').on(t.userId),
  }),
);
