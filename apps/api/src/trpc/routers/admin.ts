/**
 * Admin router — read + manage stores, members, roles, SKUs, categories.
 *
 * Every endpoint requires the `users.manage` permission, scoped to the
 * caller's org via RLS. The intent is "operator console" — fast queries
 * for an admin to see who's in the org, what's been happening, and to
 * grant/revoke roles, edit stores, and manage the SKU catalog.
 *
 * Out of scope (defer): policy_rules editing, audit log search, export.
 */
import { TRPCError } from '@trpc/server';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s } from '@compass/db';
import { ADMIN_RANK, GrantRoleInputSchema, UuidSchema } from '@compass/contracts';
import { dateInTz, todayInTz } from '@compass/domain';
import { authedProcedure, router } from '../trpc';
import { hub } from '../../realtime/hub';

function requireAdmin(perms: ReadonlySet<string>): void {
  if (!perms.has('users.manage')) {
    // M1.9-extra (P7, 2026-05-07): was
    // 'auth.errors.missingPermission:users.manage' — the colon suffix
    // broke the dot-camelCase contract every other key follows, so
    // the FE errToast helper couldn't translate it cleanly. The
    // missing perm name is implementation detail; the user-facing
    // message is generic. The actual perm goes into TRPCError.cause
    // for log forensics.
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'auth.errors.missingPermission',
      cause: { missingPermission: 'users.manage' },
    });
  }
}

/**
 * Org-tier admin gate (M3.3, 2026-05-15).
 *
 * `requireAdmin` accepts `users.manage`, which is the admin-tier
 * marker for tasks that legitimately span store + org (member
 * invitation, role granting, etc.). Manager (rank 60) holds it too
 * since M1.9 so store managers can invite their own staff.
 *
 * That overload makes `users.manage` unsuitable as a gate for
 * mutations that affect the entire org — catalog (SKU, supplier,
 * category), role definitions, org settings, store create/delete.
 * Manager has authority over THEIR stores, not over org-wide rows.
 *
 * `org.admin` is granted only to admin + super_admin (via seed +
 * migration 0022 for existing orgs). Custom roles ranked ≥ 80 can
 * be granted it explicitly. Manager never has it.
 *
 * Use this helper at every mutation that:
 *   - writes/deletes a row outside any single store's scope
 *   - changes the org's role catalog
 *   - touches finance / settings that apply chain-wide
 *
 * Keep using `requireAdmin` for store-scoped admin work where the
 * per-store gates (`getActorAdminStoreIds`, C2) already constrain
 * the cross-store reach.
 */
function requireOrgAdmin(perms: ReadonlySet<string>): void {
  if (!perms.has('org.admin')) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'auth.errors.missingPermission',
      cause: { missingPermission: 'org.admin' },
    });
  }
}

/**
 * Audit log helper for admin CRUD (added 2026-05-05).
 *
 * The order/run domains write to `domain.events` for every state change,
 * so "who edited yesterday" is queryable there. But catalog mutations
 * (SKU/category/store/supplier) wrote to inventory tables ONLY — no
 * audit trail. The pre-launch audit flagged this as a gap: an admin
 * could rename "Beef" to "Toilet paper" and there's no record.
 *
 * Cheapest fix: write a row to `domain.policy_decisions` after every
 * successful catalog mutation, with `decision='allow'` and the input
 * payload as `inputs`. The table was added in 0000 for ABAC tracing
 * but never populated; reusing it here gives admins a queryable
 * history without a new schema migration.
 *
 * Best-effort: if the audit insert throws, we log and continue —
 * the catalog change has already committed. Better to keep a
 * functional system than to roll back over an audit hiccup.
 */
/**
 * Best-effort audit row writer. `tx` is the per-request drizzle
 * transaction (whose full generic type is too hairy to inline cleanly);
 * we accept it loosely-typed and rely on the single typed insert call
 * below for safety. If the insert throws (e.g. the table is RLS-locked
 * mid-deploy), we swallow and continue — losing an audit row is
 * preferable to losing the catalog write that already committed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
/**
 * B2 (2026-05-06): derive a store id from action input so the audit
 * row can be indexed by store and the FE can filter by it.
 *
 * The keys we look at, in priority order:
 *   - storeId            — most catalog/member-store ops
 *   - scopeId + scopeType==='store' — grantRole / memberPermissionSet
 *   - targetStoreId      — memberTransferStore (the destination is
 *                          the most "in scope" — that's where the
 *                          new state lives; the from-side is captured
 *                          in the inputs JSON for forensics)
 *   - storeIds[0]        — multi-store ops (invite). The first id is
 *                          the conventional "primary" target for
 *                          single-store filtering. Audit row's `inputs`
 *                          still has the full list for cross-checks.
 *
 * Returns null when none of those resolve to a UUID — global ops like
 * `admin.role.create` legitimately have no store scope.
 */
function deriveScopeStoreId(_action: string, resourceType: string, inputs: unknown): string | null {
  // resourceType='store' implies the action targets a store directly.
  if (resourceType === 'store') {
    const o = inputs as Record<string, unknown> | null;
    if (o && typeof o === 'object') {
      const sid =
        (typeof o.storeId === 'string' ? o.storeId : null) ??
        (typeof o.targetStoreId === 'string' ? o.targetStoreId : null);
      if (sid) return sid;
    }
  }
  if (!inputs || typeof inputs !== 'object') return null;
  const o = inputs as Record<string, unknown>;
  if (typeof o.storeId === 'string') return o.storeId;
  if (
    typeof o.scopeType === 'string' &&
    o.scopeType === 'store' &&
    typeof o.scopeId === 'string'
  ) {
    return o.scopeId;
  }
  if (typeof o.targetStoreId === 'string') return o.targetStoreId;
  if (Array.isArray(o.storeIds) && o.storeIds.length === 1 && typeof o.storeIds[0] === 'string') {
    return o.storeIds[0];
  }
  return null;
}

async function auditAdmin(
  tx: any,
  ctx: { session?: { userId: string; orgId: string } | null },
  action: string,
  resourceType: string,
  resourceId: string | null,
  inputs: unknown,
): Promise<void> {
  try {
    await tx.insert(s.policyDecisions).values({
      orgId: ctx.session!.orgId,
      actorId: ctx.session!.userId,
      action,
      resourceType,
      resourceId,
      decision: 'allow',
      inputs: inputs as Record<string, unknown>,
      scopeStoreId: deriveScopeStoreId(action, resourceType, inputs),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[audit] failed to log admin action', { action, err });
  }
}

/**
 * Granular permission check — for the "can grant role" / "can assign
 * store" actions. Accepts the legacy coarse `users.manage` OR the
 * specific granular key. Lets us tighten new orgs to use the granular
 * keys without breaking existing roles that only carry users.manage.
 */
function requireOneOf(perms: ReadonlySet<string>, keys: string[]): void {
  for (const k of keys) {
    if (perms.has(k)) return;
  }
  // M1.9-extra (P7): same shape as requireAdmin — generic
  // user-facing message, missing perms in cause for forensics.
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'auth.errors.missingPermission',
    cause: { missingPermissionAny: keys },
  });
}

/**
 * "No equal/higher grants" enforcement.
 *
 * Returns the maximum rank of any role currently bound to `actorMemberId`
 * within the given org. The grant/revoke endpoints compare this against
 * the rank of the role being granted: actor's max MUST be strictly
 * greater. Without this, an admin (rank 80) could grant another admin
 * (rank 80) — letting any admin self-replicate to an unbounded pool of
 * admins, defeating tenant safety.
 *
 * super_admin is treated as platform-level: rank 100 trumps everything.
 */
/**
 * Broadcast a catalog change so other admins viewing People/Catalog
 * pages auto-refresh. Coarse — payload only carries the entity kind,
 * the client just invalidates `[admin.<list>]` queries.
 */
function broadcastCatalog(
  orgId: string,
  entity: 'store' | 'sku' | 'supplier' | 'category',
): void {
  hub.publish(orgId, { type: 'catalog.changed', orgId, entity });
}
function broadcastPeople(orgId: string): void {
  hub.publish(orgId, { type: 'people.changed', orgId });
}

/**
 * Last-admin guard. Returns the count of members in the org currently
 * bound to a role with rank ≥ ADMIN_RANK. The revoke / remove flows
 * refuse to drop the count below 1, so an org can never end up with
 * zero people who can manage it. ADMIN_RANK is 80 (built-in
 * `admin`); super_admins (rank 100) also count.
 *
 * Constant lives in `@compass/contracts` so server gates and FE
 * filters share the threshold (M1.5).
 */
const ADMIN_RANK_THRESHOLD = ADMIN_RANK;

async function countAdminsInOrg(
  tx: import('@compass/db').DB,
  orgId: string,
): Promise<number> {
  const rows = await tx
    .select({ memberId: s.memberRoleBindings.memberId })
    .from(s.memberRoleBindings)
    .innerJoin(s.members, eq(s.members.id, s.memberRoleBindings.memberId))
    .innerJoin(s.roles, eq(s.roles.id, s.memberRoleBindings.roleId))
    .where(
      and(
        eq(s.members.orgId, orgId),
        eq(s.members.status, 'active'),
        gte(s.roles.rank, ADMIN_RANK_THRESHOLD),
      ),
    );
  // Distinct member ids — one member with two admin-level roles still
  // counts as ONE admin for "last admin" purposes.
  const distinct = new Set(rows.map((r) => r.memberId));
  return distinct.size;
}

async function getActorMaxRank(
  tx: import('@compass/db').DB,
  orgId: string,
  actorUserId: string,
): Promise<number> {
  const rows = await tx
    .select({ rank: s.roles.rank })
    .from(s.memberRoleBindings)
    .innerJoin(s.members, eq(s.members.id, s.memberRoleBindings.memberId))
    .innerJoin(s.roles, eq(s.roles.id, s.memberRoleBindings.roleId))
    .where(and(eq(s.members.orgId, orgId), eq(s.members.userId, actorUserId)));
  let max = 0;
  for (const r of rows) {
    if (r.rank > max) max = r.rank;
  }
  return max;
}

/**
 * C1 (2026-05-06): per-store rank gate.
 *
 * `getActorMaxRank` returns the actor's max rank ANYWHERE in the org —
 * which silently lets a "manager of Store A" (rank 30 in A, nothing in
 * B) grant a manager-rank role bound to Store B, because the global
 * gate would see rank 30 ≥ 30 and refuse, but rank 30 < 30 succeeds…
 * wait, actually the global gate refuses correctly for SAME store.
 * The bug bites when granting INTO a different store: actor has rank
 * 30 globally (from their A binding), tries to bind manager (rank 30)
 * to Store B — gate says "30 ≥ 30, no" — correct refusal but for the
 * wrong reason. The dangerous case is the inverse: actor has rank 50
 * (some bespoke role) in Store A, tries to grant rank 40 in Store B
 * where they have ZERO authority. Global gate says "50 > 40, ok" —
 * WRONG. They had no business managing Store B.
 *
 * Rules for evaluating "actor's rank IN scope":
 *   - global bindings always count (admin/super_admin reach everywhere)
 *   - store-scoped bindings count only if scope_id == storeId
 *
 * For granting/revoking a 'global' binding, use `getActorMaxRank`
 * (unchanged). Granting a global binding is by definition org-wide and
 * the only people who should do it are themselves global admins, whose
 * global rank already gates them correctly.
 */
async function getActorMaxRankInStore(
  tx: import('@compass/db').DB,
  orgId: string,
  actorUserId: string,
  storeId: string,
): Promise<number> {
  const rows = await tx
    .select({
      rank: s.roles.rank,
      scopeType: s.memberRoleBindings.scopeType,
      scopeId: s.memberRoleBindings.scopeId,
    })
    .from(s.memberRoleBindings)
    .innerJoin(s.members, eq(s.members.id, s.memberRoleBindings.memberId))
    .innerJoin(s.roles, eq(s.roles.id, s.memberRoleBindings.roleId))
    .where(and(eq(s.members.orgId, orgId), eq(s.members.userId, actorUserId)));
  let max = 0;
  for (const r of rows) {
    const counts =
      r.scopeType === 'global' ||
      (r.scopeType === 'store' && r.scopeId === storeId);
    if (counts && r.rank > max) max = r.rank;
  }
  return max;
}

/**
 * C2 (2026-05-06): "store-scoped admins can only manage their stores".
 *
 * Returns the storeIds in which the actor is permitted to perform
 * admin-tier actions (invite a member, grant a role, assign a store).
 *
 *   - If the actor has any GLOBAL binding granting one of the admin
 *     permissions (`users.manage`, `users.invite`, `users.grant_role`),
 *     they're a "global admin" — return every active store in the org.
 *   - Otherwise, return the storeIds from store-scoped bindings whose
 *     role grants any of those perms. A store-scoped manager who can
 *     `users.invite` in Store A only is gated to Store A here.
 *   - Member-permission overrides participate too: a per-member allow
 *     `users.invite` scoped to a store extends the set; deny shrinks
 *     it. Global allow override → global admin path.
 *
 * Returns an EMPTY array if the actor has no admin authority anywhere.
 * Callers (grantRole, memberInvite, memberAssignStore) check whether
 * the target storeId is in this set; mismatches throw FORBIDDEN.
 */
const ADMIN_PERM_KEYS = ['users.manage', 'users.invite', 'users.grant_role'] as const;

async function getActorAdminStoreIds(
  tx: import('@compass/db').DB,
  orgId: string,
  actorUserId: string,
): Promise<string[]> {
  // Step 1: load actor's bindings (with scope) + the perm keys their
  // roles grant. Cheap: actor typically has ≤3 bindings.
  const member = await tx.query.members.findFirst({
    where: (m, { eq: eq2, and: and2 }) =>
      and2(eq2(m.orgId, orgId), eq2(m.userId, actorUserId)),
  });
  if (!member) return [];
  const bindings = await tx
    .select({
      roleId: s.memberRoleBindings.roleId,
      scopeType: s.memberRoleBindings.scopeType,
      scopeId: s.memberRoleBindings.scopeId,
    })
    .from(s.memberRoleBindings)
    .where(eq(s.memberRoleBindings.memberId, member.id));
  const roleIds = [...new Set(bindings.map((b) => b.roleId))];
  const rolePerms =
    roleIds.length > 0
      ? await tx
          .select({
            roleId: s.rolePermissions.roleId,
            key: s.rolePermissions.permissionKey,
          })
          .from(s.rolePermissions)
          .where(inArray(s.rolePermissions.roleId, roleIds))
      : [];
  const adminRoleIds = new Set<string>();
  for (const rp of rolePerms) {
    if ((ADMIN_PERM_KEYS as readonly string[]).includes(rp.key)) {
      adminRoleIds.add(rp.roleId);
    }
  }

  let isGlobalAdmin = false;
  const storeAdminSet = new Set<string>();
  for (const b of bindings) {
    if (!adminRoleIds.has(b.roleId)) continue;
    if (b.scopeType === 'global') isGlobalAdmin = true;
    else if (b.scopeType === 'store' && b.scopeId) storeAdminSet.add(b.scopeId);
  }

  // Step 2: per-member overrides. Allow extends; deny shrinks. We
  // only care about admin-tier perm keys here.
  const overrides = await tx
    .select({
      effect: s.memberPermissionOverrides.effect,
      scopeType: s.memberPermissionOverrides.scopeType,
      scopeId: s.memberPermissionOverrides.scopeId,
      permissionKey: s.memberPermissionOverrides.permissionKey,
      expiresAt: s.memberPermissionOverrides.expiresAt,
    })
    .from(s.memberPermissionOverrides)
    .where(eq(s.memberPermissionOverrides.memberId, member.id));
  const now = new Date();
  for (const o of overrides) {
    if (o.expiresAt && o.expiresAt <= now) continue;
    if (!(ADMIN_PERM_KEYS as readonly string[]).includes(o.permissionKey)) continue;
    if (o.effect === 'allow') {
      if (o.scopeType === 'global') isGlobalAdmin = true;
      else if (o.scopeType === 'store' && o.scopeId) storeAdminSet.add(o.scopeId);
    } else {
      // deny
      if (o.scopeType === 'global') isGlobalAdmin = false;
      else if (o.scopeType === 'store' && o.scopeId) storeAdminSet.delete(o.scopeId);
    }
  }

  if (isGlobalAdmin) {
    // Global admin → every active store in the org.
    const all = await tx
      .select({ id: s.stores.id })
      .from(s.stores)
      .where(and(eq(s.stores.orgId, orgId), eq(s.stores.isActive, true)));
    return all.map((r) => r.id);
  }
  return [...storeAdminSet];
}

// ---------- input schemas ----------

const RevokeRoleInputSchema = z.object({
  bindingId: UuidSchema,
});

// HARD RULE (2026-05-05): SKUs and categories MUST carry all four
// languages — uz, ru, en, zh. The earlier "at least one locale" rule
// let admins create a row with just English, which then broke the
// OrderPage for non-English staff (the row would render as the SKU
// code, which they couldn't read or order from). The catalog import
// script already populates all four; this schema makes that the
// permanent contract for any SKU/category created or edited via the
// Admin UI.
//
// `aliases` is left lax (record<string,string[]>) — those are search
// keywords, not display strings, and a missing locale just means
// fewer hits, not a broken render.
const NamesSchema = z
  .object({
    uz: z.string().min(1).max(200),
    ru: z.string().min(1).max(200),
    en: z.string().min(1).max(200),
    zh: z.string().min(1).max(200),
  })
  .strict();

// M3.14 (2026-05-16): step is restricted to exactly '0.5' or '1'.
//
// Earlier the schema accepted any positive decimal — but field
// operators ended up with SKU rows that stepped by 0.25, 0.1, 5,
// 50, 100 etc., depending on whoever filled the form. The QtyControl
// UI then rendered "0.25" / "0.5" / "0.75" increments that the
// procurer had no way to relate to real-world packaging. Snapping
// to 0.5 (kg/L, "weigh-and-pay" goods) or 1 (pcs/pair, countable
// goods) makes the +/- buttons readable at a glance.
//
// Migration: catalog-uzbek.ts seed and the prod data backfill both
// coerce existing rows; this schema is the gate that keeps future
// writes clean.
const StepSchema = z.enum(['0.5', '1']);

const StoreCreateInputSchema = z.object({
  name: z.string().min(1).max(200),
  code: z.string().max(32).optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  timezone: z.string().max(64).optional().nullable(),
});

const StoreUpdateInputSchema = z.object({
  storeId: UuidSchema,
  name: z.string().min(1).max(200).optional(),
  code: z.string().max(32).optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  timezone: z.string().max(64).optional().nullable(),
  isActive: z.boolean().optional(),
  /** D3: default role for new members invited into this store. Pass
   *  `null` to clear; pass an existing role's slug to set. The slug
   *  is resolved to a role-id server-side; cross-tenant role-ids
   *  can't slip in. */
  defaultRoleSlug: z.string().min(1).max(64).nullable().optional(),
});

const StoreCloneRolesInputSchema = z.object({
  sourceStoreId: UuidSchema,
  targetStoreId: UuidSchema,
  /** When true, also assign the source's members to the target store
   *  (MSA rows). Off by default — chain expansion usually wants the
   *  ROLE shape replicated but staffed by different people. */
  includeMembers: z.boolean().default(false),
});

const StoreDeleteInputSchema = z.object({
  storeId: UuidSchema,
});

const SkuCreateInputSchema = z.object({
  categoryId: UuidSchema.optional().nullable(),
  code: z.string().max(64).optional().nullable(),
  names: NamesSchema,
  unit: z.string().min(1).max(16),
  step: StepSchema.default('1'),
  sortIndex: z.number().int().default(0),
});

const SkuUpdateInputSchema = z.object({
  skuId: UuidSchema,
  categoryId: UuidSchema.optional().nullable(),
  code: z.string().max(64).optional().nullable(),
  names: NamesSchema.optional(),
  unit: z.string().min(1).max(16).optional(),
  step: StepSchema.optional(),
  sortIndex: z.number().int().optional(),
  isArchived: z.boolean().optional(),
});

const SkuDeleteInputSchema = z.object({
  skuId: UuidSchema,
});

const SupplierCreateInputSchema = z.object({
  name: z.string().min(1).max(200),
  contactPhone: z.string().max(32).optional().nullable(),
  contactTg: z.string().max(64).optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
});

const SupplierUpdateInputSchema = z.object({
  supplierId: UuidSchema,
  name: z.string().min(1).max(200).optional(),
  contactPhone: z.string().max(32).optional().nullable(),
  contactTg: z.string().max(64).optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
  isArchived: z.boolean().optional(),
});

const SupplierDeleteInputSchema = z.object({
  supplierId: UuidSchema,
});

const CategoryCreateInputSchema = z.object({
  slug: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  names: NamesSchema,
  sortIndex: z.number().int().default(0),
});

const CategoryUpdateInputSchema = z.object({
  categoryId: UuidSchema,
  slug: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/).optional(),
  names: NamesSchema.optional(),
  sortIndex: z.number().int().optional(),
  isArchived: z.boolean().optional(),
});

const CategoryDeleteInputSchema = z.object({
  categoryId: UuidSchema,
});

const MemberSetStatusInputSchema = z.object({
  memberId: UuidSchema,
  status: z.enum(['active', 'suspended']),
});

const MemberRemoveInputSchema = z.object({
  memberId: UuidSchema,
});

const InviteMemberByTgIdInputSchema = z.object({
  tgUserId: z.string().regex(/^\d{4,15}$/, 'Telegram ID must be a numeric string').transform((s) => BigInt(s)),
  displayName: z.string().min(1).max(200).optional(),
  roleSlug: z.string().min(1).max(64).optional(),
  /** Stores to assign at invite time. The new model REQUIRES at least
   *  one store unless the role is admin/super_admin (which bypass via
   *  users.manage permission). */
  storeIds: z.array(UuidSchema).default([]),
});

const MemberSetDisplayNameInputSchema = z.object({
  memberId: UuidSchema,
  displayName: z.string().min(1).max(200),
});

const MemberAssignStoreInputSchema = z.object({
  memberId: UuidSchema,
  storeId: UuidSchema,
});

const MemberUnassignStoreInputSchema = z.object({
  memberId: UuidSchema,
  storeId: UuidSchema,
});

const MemberDetachFromStoreInputSchema = z.object({
  memberId: UuidSchema,
  storeId: UuidSchema,
});

const MemberTransferStoreInputSchema = z.object({
  memberId: UuidSchema,
  fromStoreId: UuidSchema,
  toStoreId: UuidSchema,
  /** When true (default) we mirror role bindings: every store-scoped
   *  binding the member had in `fromStoreId` is recreated against
   *  `toStoreId` so they keep the same operational role at the new
   *  location. When false we only move the MSA assignment and let
   *  the operator grant roles separately. */
  mirrorRoles: z.boolean().default(true),
});

/**
 * Purge ALL transactional data for the caller's org. Wipes events,
 * snapshots, read-model projections, price history, notifications,
 * outbox, idempotency keys, projector cursors. Does NOT touch:
 *   - org / user / member / role rows (the workspace stays alive)
 *   - stores / categories / skus / suppliers (the catalog stays)
 *   - audit log (kept for forensics)
 *
 * Two-phase by design:
 *   - dryRun=true (default) returns row counts WITHOUT deleting.
 *   - dryRun=false requires `confirmText` to match the org slug
 *     exactly. The FE shows the slug in the confirm sheet so the user
 *     literally types it; if they fat-finger, nothing happens.
 */
const PurgeAllTestDataInputSchema = z.object({
  dryRun: z.boolean().default(true),
  confirmText: z.string().optional(),
});

/**
 * Purge a single day's order→run→delivery flow. Scoped by date (the
 * orderDate on sessions / runDate on runs); everything else is left
 * alone. This is the "I just tested a complete flow, let me re-test
 * tomorrow… actually let me re-test in 30 seconds" knob.
 *
 * No typed confirm needed — the date itself is the safety: if the user
 * passed the wrong date, the dryRun's row counts will reveal it before
 * they tap commit.
 */
const PurgeByDateInputSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  dryRun: z.boolean().default(true),
});

/**
 * Targeted single-session purge. The common case: an admin placed a
 * test order at the same time real staff are placing real orders, and
 * needs to wipe ONLY their own test session — surgically — without
 * touching anyone else's data.
 *
 * Cascade rules:
 *   - status in {draft, submitted, rejected, approved}: delete the
 *     session + items + events + snapshots + notifications. The
 *     session is not part of any run yet, so nothing else is touched.
 *   - status in {in_run, archived}: REFUSED. Caller must purge the
 *     run instead (or eject the session via the normal run UI first).
 *     We refuse rather than silently mutating run aggregates because
 *     re-deriving a run's planned totals after a partial deletion is
 *     a non-trivial replay job.
 */
const PurgeSessionInputSchema = z.object({
  sessionId: UuidSchema,
  dryRun: z.boolean().default(true),
});

/**
 * Whole-run purge. Deletes the run + every session attached to it +
 * every event/store-delivery/notification derived from that flow.
 *
 * Use this when an admin tested through to delivery (so the session
 * is in_run/archived and can't be deleted in isolation), OR when a
 * test run was created with multiple test sessions inside it.
 *
 * SAFETY: if `requireOnlyTestSessions: true` (default), refuses if
 * any attached session was created by a member OTHER than the caller.
 * That way you can't accidentally nuke a real run that just happens
 * to share a runId with a test session.
 */
const PurgeRunInputSchema = z.object({
  runId: UuidSchema,
  dryRun: z.boolean().default(true),
  requireOnlyTestSessions: z.boolean().default(true),
});

// ---------- router ----------

export const adminRouter = router({
  /** Org-level dashboard summary. */
  overview: authedProcedure.query(async ({ ctx }) => {
    requireAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      const [memberCount] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.members)
        .where(eq(s.members.orgId, orgId));
      const [storeCount] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.stores)
        .where(eq(s.stores.orgId, orgId));
      const [skuCount] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.skus)
        .where(and(eq(s.skus.orgId, orgId), eq(s.skus.isArchived, false)));
      const [runCount] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.marketRunsV)
        .where(eq(s.marketRunsV.orgId, orgId));
      const [pendingApprovals] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.orderSessionsV)
        .where(
          and(
            eq(s.orderSessionsV.orgId, orgId),
            eq(s.orderSessionsV.status, 'submitted'),
          ),
        );
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const [ordersThisWeek] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.orderSessionsV)
        .where(
          and(
            eq(s.orderSessionsV.orgId, orgId),
            gte(s.orderSessionsV.updatedAt, sevenDaysAgo),
          ),
        );
      return {
        memberCount: memberCount?.n ?? 0,
        storeCount: storeCount?.n ?? 0,
        skuCount: skuCount?.n ?? 0,
        runCount: runCount?.n ?? 0,
        pendingApprovals: pendingApprovals?.n ?? 0,
        ordersThisWeek: ordersThisWeek?.n ?? 0,
      };
    });
  }),

  // ============ ORG FINANCIAL SETTINGS (M1.17) ============
  //
  // Read-only `overview` already returns the org name + ID. M1.17
  // adds an editor for the financial trio (currency, tax rate,
  // prices_include_tax). Gated on users.manage — these are
  // organization-wide policy levers that should never be touched by
  // a store manager unilaterally. Effect:
  //
  //   - Mutating `currency` does NOT re-denominate historical money
  //     columns. It only shifts the suffix the FE renders going
  //     forward. Operators MUST treat this as set-once per org.
  //   - Mutating `taxRatePct` is a forward-only display change for
  //     reports; per-transaction tax capture (M2.x) will snapshot the
  //     rate at purchase time, so historical edits won't retroactively
  //     rewrite past calculations.
  //   - Mutating `pricesIncludeTax` flips how reports interpret stored
  //     unit prices. Operators should align this with how their
  //     suppliers actually quote (most market stalls quote gross).
  // M3.3: org finance settings are org-wide; only org.admin can edit.
  orgFinanceUpdate: authedProcedure
    .input(
      z.object({
        currency: z
          .string()
          .length(3)
          .regex(/^[A-Z]{3}$/, 'currency must be ISO-4217 (3 uppercase letters)'),
        taxRatePct: z
          .string()
          .regex(/^\d{1,3}(\.\d{1,2})?$/, 'tax must be a number, max 2 decimals'),
        pricesIncludeTax: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireOrgAdmin(ctx.session!.permissions);
      // Reject runaway tax rates — 50% is the legal ceiling pretty
      // much everywhere; anything higher is almost certainly a typo.
      // (Hungary has the world's highest standard VAT at 27%, so 50
      // leaves headroom for special items.)
      const taxNum = Number(input.taxRatePct);
      if (!Number.isFinite(taxNum) || taxNum < 0 || taxNum > 50) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'admin.errors.taxRateOutOfRange',
        });
      }
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        await tx
          .update(s.organizations)
          .set({
            currency: input.currency,
            taxRatePct: input.taxRatePct,
            pricesIncludeTax: input.pricesIncludeTax,
            updatedAt: new Date(),
          })
          .where(eq(s.organizations.id, orgId));
        await auditAdmin(
          tx,
          ctx,
          'admin.orgFinanceUpdate',
          'organization',
          orgId,
          input,
        );
        return { ok: true as const };
      });
    }),

  // ============ MEMBERS ============

  memberList: authedProcedure.query(async ({ ctx }) => {
    requireAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      const rows = await tx
        .select({
          memberId: s.members.id,
          userId: s.users.id,
          tgUserId: s.users.tgUserId,
          tgUsername: s.users.tgUsername,
          displayName: s.users.displayName,
          avatarUrl: s.users.avatarUrl,
          status: s.members.status,
          joinedAt: s.members.joinedAt,
          lastSeenAt: s.users.lastSeenAt,
        })
        .from(s.members)
        .innerJoin(s.users, eq(s.users.id, s.members.userId))
        .where(eq(s.members.orgId, orgId))
        .orderBy(desc(s.members.joinedAt));

      if (rows.length === 0) return [];

      const memberIds = rows.map((r) => r.memberId);
      // Three parallel reads — roles, MSA store assignments, and the
      // store names themselves. The FE wants `stores` per-member so it
      // can group/filter the directory by store (added 2026-05-05). A
      // member's stores = MSA rows ∪ role-binding scopes (mirror of
      // server-side getActorStoreIds).
      const [bindings, msa, allStores] = await Promise.all([
        tx
          .select({
            bindingId: s.memberRoleBindings.id,
            memberId: s.memberRoleBindings.memberId,
            roleSlug: s.roles.slug,
            roleName: s.roles.name,
            scopeType: s.memberRoleBindings.scopeType,
            scopeId: s.memberRoleBindings.scopeId,
          })
          .from(s.memberRoleBindings)
          .innerJoin(s.roles, eq(s.roles.id, s.memberRoleBindings.roleId))
          .where(inArray(s.memberRoleBindings.memberId, memberIds)),
        tx
          .select({
            memberId: s.memberStoreAssignments.memberId,
            storeId: s.memberStoreAssignments.storeId,
          })
          .from(s.memberStoreAssignments)
          .where(inArray(s.memberStoreAssignments.memberId, memberIds)),
        tx
          .select({
            id: s.stores.id,
            name: s.stores.name,
            code: s.stores.code,
          })
          .from(s.stores)
          .where(and(eq(s.stores.orgId, orgId), eq(s.stores.isActive, true))),
      ]);

      const rolesByMember = new Map<
        string,
        Array<{ bindingId: string; slug: string; name: string; scopeType: string; scopeId: string | null }>
      >();
      for (const b of bindings) {
        const arr = rolesByMember.get(b.memberId) ?? [];
        arr.push({
          bindingId: b.bindingId,
          slug: b.roleSlug,
          name: b.roleName,
          scopeType: b.scopeType,
          scopeId: b.scopeId,
        });
        rolesByMember.set(b.memberId, arr);
      }

      const storeById = new Map(allStores.map((st) => [st.id, st]));
      const storesByMember = new Map<string, Set<string>>();
      for (const a of msa) {
        const set = storesByMember.get(a.memberId) ?? new Set();
        set.add(a.storeId);
        storesByMember.set(a.memberId, set);
      }
      // Role-binding scopeIds count too — a manager bound to "store B"
      // is "in" store B even without an MSA row.
      for (const b of bindings) {
        if (b.scopeType === 'store' && b.scopeId) {
          const set = storesByMember.get(b.memberId) ?? new Set();
          set.add(b.scopeId);
          storesByMember.set(b.memberId, set);
        }
      }

      return rows.map((r) => {
        const storeIds = [...(storesByMember.get(r.memberId) ?? [])];
        return {
          memberId: r.memberId,
          userId: r.userId,
          tgUserId: r.tgUserId !== null ? r.tgUserId.toString() : null,
          tgUsername: r.tgUsername,
          displayName: r.displayName,
          avatarUrl: r.avatarUrl,
          status: r.status,
          joinedAt: r.joinedAt.toISOString(),
          lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
          roles: rolesByMember.get(r.memberId) ?? [],
          stores: storeIds
            .map((id) => storeById.get(id))
            .filter((st): st is NonNullable<typeof st> => !!st),
        };
      });
    });
  }),

  memberSetStatus: authedProcedure.input(MemberSetStatusInputSchema).mutation(async ({ ctx, input }) => {
    requireAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      const member = await tx.query.members.findFirst({
        where: (m, { eq: eq2, and: and2 }) =>
          and2(eq2(m.id, input.memberId), eq2(m.orgId, orgId)),
      });
      if (!member) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.memberNotFound' });
      }
      // Don't let an admin lock themselves out: refuse to suspend self.
      if (member.userId === ctx.session!.userId && input.status === 'suspended') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'admin.errors.cannotSuspendSelf',
        });
      }
      // Last-admin guard for suspend.
      if (input.status === 'suspended') {
        const targetMaxRank = await getActorMaxRank(tx, orgId, member.userId);
        if (targetMaxRank >= ADMIN_RANK_THRESHOLD) {
          const adminCount = await countAdminsInOrg(tx, orgId);
          if (adminCount <= 1) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'admin.errors.cannotRemoveLastAdmin',
            });
          }
        }
      }
      await tx
        .update(s.members)
        .set({ status: input.status })
        .where(eq(s.members.id, input.memberId));
      broadcastPeople(orgId);
      return { ok: true };
    });
  }),

  /**
   * Invite a member by Telegram user ID. Auto-provisions a user row
   * (display name will be filled in on first /start) and a member row.
   * Optionally grants a role at the same time so the new member has
   * working permissions before they ever open the app.
   *
   * Idempotent: re-invoking with the same tgUserId is a no-op (returns
   * the existing memberId). Role grant is also idempotent — the existing
   * grantRole helper handles that.
   */
  memberInviteByTgId: authedProcedure
    .input(InviteMemberByTgIdInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        // SECURITY (2026-05-04): non-admin invitees must have at least
        // one store, otherwise every store-scoped query returns empty
        // for them and they appear active but locked out. Admins
        // (super_admin / admin) bypass since they see all stores via
        // the admin bypass in assertActorAssignedToStore.
        const isAdminInvite =
          input.roleSlug === 'super_admin' || input.roleSlug === 'admin';
        if (!isAdminInvite && input.storeIds.length === 0) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'admin.errors.inviteNeedsStore',
          });
        }
        // C2 (2026-05-06): a store-scoped admin (e.g. manager-of-A)
        // can only invite people INTO their own stores. Without this,
        // a manager-of-A could pass `storeIds: [B.id]` and silently
        // hire someone for Store B, where they have no authority.
        //
        // We allow the special case `isAdminInvite` (super_admin /
        // admin) only when the actor is themselves a global admin —
        // otherwise a store-scoped manager could elevate someone to
        // org-wide admin from inside their store. The grantRole gate
        // would normally block that via the rank check, but the
        // invite path inlines its own grant so we mirror the rule
        // here.
        const actorAdminStores = await getActorAdminStoreIds(
          tx,
          orgId,
          ctx.session!.userId,
        );
        if (input.storeIds.length > 0) {
          const allowed = new Set(actorAdminStores);
          for (const sid of input.storeIds) {
            if (!allowed.has(sid)) {
              throw new TRPCError({
                code: 'FORBIDDEN',
                message: 'admin.errors.notAdminOfStore',
              });
            }
          }
        }
        if (isAdminInvite) {
          // Granting an org-tier role requires the actor to be a global
          // admin. Detect this by checking if the actor's adminStoreIds
          // covers ALL active stores in the org — that's the signal we
          // use elsewhere.
          const allOrgStores = await tx
            .select({ id: s.stores.id })
            .from(s.stores)
            .where(and(eq(s.stores.orgId, orgId), eq(s.stores.isActive, true)));
          const allowedSet = new Set(actorAdminStores);
          const isGlobalAdmin = allOrgStores.every((st) => allowedSet.has(st.id));
          if (!isGlobalAdmin) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'admin.errors.cannotInviteOrgAdminAsStoreAdmin',
            });
          }
        }
        // Find or auto-provision the user.
        let user = await tx.query.users.findFirst({
          where: (u, { eq: eq2 }) => eq2(u.tgUserId, input.tgUserId),
        });
        if (!user) {
          const fallbackName = input.displayName ?? `tg:${input.tgUserId.toString()}`;
          const [created] = await tx
            .insert(s.users)
            .values({
              tgUserId: input.tgUserId,
              displayName: fallbackName,
            })
            .returning();
          user = created;
        } else if (input.displayName && user.displayName.startsWith('tg:')) {
          // Existing placeholder — update with the more useful name.
          await tx
            .update(s.users)
            .set({ displayName: input.displayName })
            .where(eq(s.users.id, user.id));
        }
        if (!user) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'admin.errors.userCreateFailed' });
        }
        // Find or create the member.
        let member = await tx.query.members.findFirst({
          where: (m, { eq: eq2, and: and2 }) =>
            and2(eq2(m.orgId, orgId), eq2(m.userId, user.id)),
        });
        const created = !member;
        if (!member) {
          const [m] = await tx
            .insert(s.members)
            .values({ orgId, userId: user.id, status: 'active', invitedBy: ctx.session!.userId })
            .returning();
          member = m;
        }
        if (!member) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'admin.errors.memberCreateFailed' });
        }
        // Optional role grant.
        // SECURITY (2026-05-04): same rank gate as admin.grantRole. Without
        // this, an admin could invite + grant `admin` (or `super_admin`)
        // in one call, fully bypassing the round-1 "no equal/higher
        // grants" rule. The fix mirrors grantRole's check.
        //
        // STORE-SCOPING (added 2026-05-05): non-admin roles get fanned out
        // to one store-scoped binding per storeId, NOT a single global
        // binding. This mirrors the contract that admin.grantRole now
        // enforces: rank < 80 must be store-scoped. The earlier global
        // path could let a `manager` accidentally see every org's
        // session via the queue. Admin-tier roles still get a single
        // global binding because they ARE org-tier.
        if (input.roleSlug) {
          const role = await tx.query.roles.findFirst({
            where: (r, { eq: eq2, and: and2 }) =>
              and2(eq2(r.orgId, orgId), eq2(r.slug, input.roleSlug!)),
          });
          if (!role) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.roleNotFound' });
          }
          // C1 (2026-05-06): rank gate is per-scope.
          //   - Org-tier role (≥80) → global rank.
          //   - Sub-admin role → must outrank in EVERY target store.
          // The "every store" rule prevents a manager-of-A who's also
          // staff-of-B from inviting a manager-of-B (where A grants
          // them rank 30 but B only grants rank 10).
          if (role.rank >= ADMIN_RANK) {
            const actorRank = await getActorMaxRank(tx, orgId, ctx.session!.userId);
            if (role.rank >= actorRank) {
              throw new TRPCError({
                code: 'FORBIDDEN',
                message: 'auth.errors.cannotGrantEqualOrHigher',
              });
            }
          } else {
            for (const storeId of input.storeIds) {
              const actorRankInStore = await getActorMaxRankInStore(
                tx,
                orgId,
                ctx.session!.userId,
                storeId,
              );
              if (role.rank >= actorRankInStore) {
                throw new TRPCError({
                  code: 'FORBIDDEN',
                  message: 'auth.errors.cannotGrantEqualOrHigher',
                });
              }
            }
          }
          if (role.rank >= ADMIN_RANK) {
            // Org-tier role → single global binding. Existing-row check
            // makes the operation idempotent.
            const existing = await tx.query.memberRoleBindings.findFirst({
              where: (b, { eq: eq2, and: and2 }) =>
                and2(
                  eq2(b.memberId, member!.id),
                  eq2(b.roleId, role.id),
                  eq2(b.scopeType, 'global'),
                ),
            });
            if (!existing) {
              await tx.insert(s.memberRoleBindings).values({
                memberId: member.id,
                roleId: role.id,
                scopeType: 'global',
                grantedBy: ctx.session!.userId,
              });
            }
          } else {
            // Sub-admin role → one binding per assigned store. The
            // `inviteNeedsStore` guard at line ~585 already ensured
            // storeIds is non-empty for non-admin invites, so we can
            // safely fan out here.
            for (const storeId of input.storeIds) {
              const existing = await tx.query.memberRoleBindings.findFirst({
                where: (b, { eq: eq2, and: and2 }) =>
                  and2(
                    eq2(b.memberId, member!.id),
                    eq2(b.roleId, role.id),
                    eq2(b.scopeType, 'store'),
                    eq2(b.scopeId, storeId),
                  ),
              });
              if (!existing) {
                await tx.insert(s.memberRoleBindings).values({
                  memberId: member.id,
                  roleId: role.id,
                  scopeType: 'store',
                  scopeId: storeId,
                  grantedBy: ctx.session!.userId,
                });
              }
            }
          }
        }
        // Store assignments (new in 0003). Each storeId must belong to
        // the same org as the member; we filter rather than throw so a
        // partially-bad input doesn't roll back the rest of the invite.
        if (input.storeIds.length > 0) {
          const validStores = await tx.query.stores.findMany({
            where: (st, { eq: eq2, and: and2, inArray: ia }) =>
              and2(eq2(st.orgId, orgId), ia(st.id, input.storeIds)),
          });
          for (const store of validStores) {
            await tx
              .insert(s.memberStoreAssignments)
              .values({
                memberId: member.id,
                storeId: store.id,
                assignedBy: ctx.session!.userId,
              })
              .onConflictDoNothing();
          }
          // D3 (2026-05-06): per-store default-role fall-through. If
          // the operator didn't pick a role explicitly AND a target
          // store has `default_role_id` set, grant THAT role bound
          // to that store. Each store decides its own default; if a
          // store doesn't set one, no fallback for that store.
          //
          // We only walk this path when input.roleSlug is empty —
          // an explicit pick always wins so the operator can override
          // a default ad-hoc.
          //
          // Rank gate still applies: skip + log if the actor doesn't
          // outrank the default in the target store. We don't throw
          // on the first one we can't grant — partial assignment is
          // better than no invite. (The caller can read returned
          // counts to know what stuck.)
          if (!input.roleSlug) {
            for (const store of validStores) {
              if (!store.defaultRoleId) continue;
              const role = await tx.query.roles.findFirst({
                where: (r, { eq: eq2 }) => eq2(r.id, store.defaultRoleId!),
              });
              if (!role || role.rank >= ADMIN_RANK_THRESHOLD) continue;
              const actorRankInStore = await getActorMaxRankInStore(
                tx,
                orgId,
                ctx.session!.userId,
                store.id,
              );
              if (role.rank >= actorRankInStore) continue;
              const existing = await tx.query.memberRoleBindings.findFirst({
                where: (b, { eq: eq2, and: and2 }) =>
                  and2(
                    eq2(b.memberId, member!.id),
                    eq2(b.roleId, role.id),
                    eq2(b.scopeType, 'store'),
                    eq2(b.scopeId, store.id),
                  ),
              });
              if (!existing) {
                await tx.insert(s.memberRoleBindings).values({
                  memberId: member.id,
                  roleId: role.id,
                  scopeType: 'store',
                  scopeId: store.id,
                  grantedBy: ctx.session!.userId,
                });
              }
            }
          }
        }
        broadcastPeople(orgId);
      return { memberId: member.id, userId: user.id, created };
      });
    }),

  /**
   * Admin override: rename a member. Bypasses the
   * `displayNameLocked` self-protection — that's exactly the path
   * intended for "I made a typo at onboarding, fix me".
   */
  memberSetDisplayName: authedProcedure
    .input(MemberSetDisplayNameInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const member = await tx.query.members.findFirst({
          where: (m, { eq: eq2, and: and2 }) =>
            and2(eq2(m.id, input.memberId), eq2(m.orgId, orgId)),
        });
        if (!member) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.memberNotFound' });
        }
        await tx
          .update(s.users)
          .set({
            displayName: input.displayName.trim(),
            displayNameLocked: true,
            updatedAt: new Date(),
          })
          .where(eq(s.users.id, member.userId));
        broadcastPeople(orgId);
      return { ok: true };
      });
    }),

  /**
   * List the stores a given member is assigned to. Drives the admin
   * panel's per-member "Assigned stores" section.
   */
  memberStoreAssignments: authedProcedure
    .input(z.object({ memberId: UuidSchema }))
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const member = await tx.query.members.findFirst({
          where: (m, { eq: eq2, and: and2 }) =>
            and2(eq2(m.id, input.memberId), eq2(m.orgId, orgId)),
        });
        if (!member) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.memberNotFound' });
        }
        const rows = await tx
          .select({
            storeId: s.memberStoreAssignments.storeId,
            assignedAt: s.memberStoreAssignments.assignedAt,
            storeName: s.stores.name,
            storeCode: s.stores.code,
          })
          .from(s.memberStoreAssignments)
          .innerJoin(s.stores, eq(s.stores.id, s.memberStoreAssignments.storeId))
          .where(eq(s.memberStoreAssignments.memberId, input.memberId))
          .orderBy(s.stores.sortIndex);
        return rows.map((r) => ({
          storeId: r.storeId,
          name: r.storeName,
          code: r.storeCode,
          assignedAt: r.assignedAt.toISOString(),
        }));
      });
    }),

  memberAssignStore: authedProcedure
    .input(MemberAssignStoreInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        // Cross-tenant guard: the store + member must both be in the
        // caller's org.
        const [member, store] = await Promise.all([
          tx.query.members.findFirst({
            where: (m, { eq: eq2, and: and2 }) =>
              and2(eq2(m.id, input.memberId), eq2(m.orgId, orgId)),
          }),
          tx.query.stores.findFirst({
            where: (st, { eq: eq2, and: and2 }) =>
              and2(eq2(st.id, input.storeId), eq2(st.orgId, orgId)),
          }),
        ]);
        if (!member) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.memberNotFound' });
        }
        if (!store) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.storeNotFound' });
        }
        // C2 (2026-05-06): only admin-of-this-store can attach a member
        // to it. Mirrors the invite + grant gates.
        const allowed = await getActorAdminStoreIds(tx, orgId, ctx.session!.userId);
        if (!allowed.includes(input.storeId)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'admin.errors.notAdminOfStore',
          });
        }
        await tx
          .insert(s.memberStoreAssignments)
          .values({
            memberId: input.memberId,
            storeId: input.storeId,
            assignedBy: ctx.session!.userId,
          })
          .onConflictDoNothing();
        broadcastPeople(orgId);
      return { ok: true };
      });
    }),

  memberUnassignStore: authedProcedure
    .input(MemberUnassignStoreInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const member = await tx.query.members.findFirst({
          where: (m, { eq: eq2, and: and2 }) =>
            and2(eq2(m.id, input.memberId), eq2(m.orgId, orgId)),
        });
        if (!member) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.memberNotFound' });
        }
        // C2 (2026-05-06): can only unassign from a store the actor
        // administers. Symmetric to memberAssignStore.
        const allowedStores = await getActorAdminStoreIds(tx, orgId, ctx.session!.userId);
        if (!allowedStores.includes(input.storeId)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'admin.errors.notAdminOfStore',
          });
        }
        // SECURITY (2026-05-04): non-admin members must keep at least one
        // store assignment, otherwise they appear "active" but every
        // store-scoped query returns empty and they can't do anything.
        // Admins (rank ≥ 80) bypass via the assertActorAssignedToStore
        // admin-bypass and don't need an assignment to function.
        const targetMaxRank = await getActorMaxRank(tx, orgId, member.userId);
        if (targetMaxRank < ADMIN_RANK_THRESHOLD) {
          const remaining = await tx
            .select({ storeId: s.memberStoreAssignments.storeId })
            .from(s.memberStoreAssignments)
            .where(eq(s.memberStoreAssignments.memberId, input.memberId));
          // After this delete, count would drop to (remaining-1). Refuse
          // if removing this assignment would leave them with zero.
          const willRemain = remaining.filter(
            (r) => r.storeId !== input.storeId,
          ).length;
          if (willRemain === 0) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'admin.errors.cannotLeaveZeroStores',
            });
          }
        }
        await tx
          .delete(s.memberStoreAssignments)
          .where(
            and(
              eq(s.memberStoreAssignments.memberId, input.memberId),
              eq(s.memberStoreAssignments.storeId, input.storeId),
            ),
          );
        broadcastPeople(orgId);
      return { ok: true };
      });
    }),

  /**
   * D1 (2026-05-06): atomically detach a member from a store.
   *
   * "Detach" means: remove the MSA row AND revoke every store-scoped
   * role binding the member holds in that store, in one transaction.
   * Without the role-binding revoke, the member would still see the
   * store via the auth.ts UNION (binding scopeIds count too) and
   * appear "removed but still hanging on" — confusing for operators.
   *
   * This is the right primitive for the "员工不在这家店干了" UX:
   *   - chef quits Store A but still works at Store B → detach A only;
   *     their B assignment + B role bindings stay
   *   - someone graduates from staff → preserves audit trail (we delete
   *     the binding rows; the role-grant audit event in `domain.events`
   *     remains)
   *
   * Returns counts so the FE can show "removed from Store X · revoked
   * 2 role bindings" in the toast.
   */
  memberDetachFromStore: authedProcedure
    .input(MemberDetachFromStoreInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const [member, store] = await Promise.all([
          tx.query.members.findFirst({
            where: (m, { eq: eq2, and: and2 }) =>
              and2(eq2(m.id, input.memberId), eq2(m.orgId, orgId)),
          }),
          tx.query.stores.findFirst({
            where: (st, { eq: eq2, and: and2 }) =>
              and2(eq2(st.id, input.storeId), eq2(st.orgId, orgId)),
          }),
        ]);
        if (!member) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.memberNotFound' });
        }
        if (!store) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.storeNotFound' });
        }
        // C2: must administer the store you're detaching from.
        const allowed = await getActorAdminStoreIds(tx, orgId, ctx.session!.userId);
        if (!allowed.includes(input.storeId)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'admin.errors.notAdminOfStore',
          });
        }
        // C1: rank gate evaluated in this store. A manager-rank-30 of
        // Store A cannot detach a manager-rank-30 of Store A — same
        // rule as revokeRole, applied to all bindings we're about to
        // delete plus the MSA row.
        const targetRank = await getActorMaxRankInStore(
          tx,
          orgId,
          member.userId,
          input.storeId,
        );
        const actorRank = await getActorMaxRankInStore(
          tx,
          orgId,
          ctx.session!.userId,
          input.storeId,
        );
        if (targetRank >= actorRank) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'auth.errors.cannotRevokeEqualOrHigher',
          });
        }
        // Last-store guard — same rule as memberUnassignStore so the
        // member doesn't end up with zero stores AND zero authority
        // (orphaned active member). Admin-tier members bypass since
        // they don't depend on MSA for read scope.
        const targetMaxRank = await getActorMaxRank(tx, orgId, member.userId);
        if (targetMaxRank < ADMIN_RANK_THRESHOLD) {
          const remaining = await tx
            .select({ storeId: s.memberStoreAssignments.storeId })
            .from(s.memberStoreAssignments)
            .where(eq(s.memberStoreAssignments.memberId, input.memberId));
          // After detach, the member's "stores" UNION drops both the
          // MSA row for this store AND any store-scoped binding's
          // scopeId for this store. We need to ensure SOMETHING
          // remains in either source.
          const remainingMsaIds = new Set(
            remaining.filter((r) => r.storeId !== input.storeId).map((r) => r.storeId),
          );
          if (remainingMsaIds.size === 0) {
            // Check if a store-scoped binding for a DIFFERENT store
            // would still keep them in some store.
            const otherBindings = await tx
              .select({ scopeId: s.memberRoleBindings.scopeId })
              .from(s.memberRoleBindings)
              .where(
                and(
                  eq(s.memberRoleBindings.memberId, input.memberId),
                  eq(s.memberRoleBindings.scopeType, 'store'),
                ),
              );
            const otherIds = otherBindings
              .map((b) => b.scopeId)
              .filter((id): id is string => !!id && id !== input.storeId);
            if (otherIds.length === 0) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: 'admin.errors.cannotLeaveZeroStores',
              });
            }
          }
        }
        // Atomic detach in a single tx — ctx.withOrg already gives us
        // one. If either delete fails, both roll back.
        const revokedBindings = await tx
          .delete(s.memberRoleBindings)
          .where(
            and(
              eq(s.memberRoleBindings.memberId, input.memberId),
              eq(s.memberRoleBindings.scopeType, 'store'),
              eq(s.memberRoleBindings.scopeId, input.storeId),
            ),
          )
          .returning({ id: s.memberRoleBindings.id });
        // Also drop store-scoped permission overrides (if any). These
        // are dead weight without the store assignment — re-attaching
        // later should start with a clean slate.
        const revokedOverrides = await tx
          .delete(s.memberPermissionOverrides)
          .where(
            and(
              eq(s.memberPermissionOverrides.memberId, input.memberId),
              eq(s.memberPermissionOverrides.scopeType, 'store'),
              eq(s.memberPermissionOverrides.scopeId, input.storeId),
            ),
          )
          .returning({ id: s.memberPermissionOverrides.id });
        await tx
          .delete(s.memberStoreAssignments)
          .where(
            and(
              eq(s.memberStoreAssignments.memberId, input.memberId),
              eq(s.memberStoreAssignments.storeId, input.storeId),
            ),
          );
        await auditAdmin(
          tx,
          ctx,
          'admin.memberDetachFromStore',
          'member',
          member.id,
          { ...input, revokedBindings: revokedBindings.length, revokedOverrides: revokedOverrides.length },
        );
        broadcastPeople(orgId);
        return {
          ok: true,
          revokedBindings: revokedBindings.length,
          revokedOverrides: revokedOverrides.length,
        };
      });
    }),

  /**
   * D2 (2026-05-06): atomically transfer a member from one store to
   * another.
   *
   * Conceptually: detach(from) + assign(to) + (optionally) mirror the
   * role bindings from `from` into `to`. The actor must administer
   * BOTH stores.
   *
   *   - If `mirrorRoles=true` (default), every store-scoped binding the
   *     member held in `fromStoreId` is duplicated against `toStoreId`
   *     before the from-side bindings are deleted. The rank gate
   *     applies in BOTH stores: actor must outrank target in `from`
   *     (to revoke) AND outrank the would-be binding in `to` (to grant).
   *
   *   - If `mirrorRoles=false`, we only move the MSA row. Roles in
   *     `from` are revoked and roles in `to` are NOT created — the
   *     operator grants new roles separately. Useful when the move
   *     also implies a role change ("promoted from staff to manager").
   *
   * Returns counts so the FE can render "Transferred · 2 roles mirrored
   * · 1 override dropped".
   */
  memberTransferStore: authedProcedure
    .input(MemberTransferStoreInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      if (input.fromStoreId === input.toStoreId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'admin.errors.transferSameStore',
        });
      }
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const [member, fromStore, toStore] = await Promise.all([
          tx.query.members.findFirst({
            where: (m, { eq: eq2, and: and2 }) =>
              and2(eq2(m.id, input.memberId), eq2(m.orgId, orgId)),
          }),
          tx.query.stores.findFirst({
            where: (st, { eq: eq2, and: and2 }) =>
              and2(eq2(st.id, input.fromStoreId), eq2(st.orgId, orgId)),
          }),
          tx.query.stores.findFirst({
            where: (st, { eq: eq2, and: and2 }) =>
              and2(eq2(st.id, input.toStoreId), eq2(st.orgId, orgId)),
          }),
        ]);
        if (!member) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.memberNotFound' });
        }
        if (!fromStore || !toStore) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.storeNotFound' });
        }
        // C2: must administer BOTH stores. Without this, a manager-of-A
        // could "transfer" a B-staff into A by passing fromStoreId=B —
        // they'd successfully ATTACH the member to A but the from-side
        // would silently fail (no admin authority in B). Refuse up front.
        const allowed = await getActorAdminStoreIds(tx, orgId, ctx.session!.userId);
        if (!allowed.includes(input.fromStoreId) || !allowed.includes(input.toStoreId)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'admin.errors.notAdminOfStore',
          });
        }
        // C1: rank gate in BOTH stores. The "from" rank must outrank
        // the target IN from-store (mirror of detach). The "to" rank
        // must outrank the TARGET ROLE IF we're mirroring (mirror of
        // grant). Without mirroring, the to-side has no rank constraint
        // because we're not creating any binding there.
        const fromActorRank = await getActorMaxRankInStore(
          tx,
          orgId,
          ctx.session!.userId,
          input.fromStoreId,
        );
        const fromTargetRank = await getActorMaxRankInStore(
          tx,
          orgId,
          member.userId,
          input.fromStoreId,
        );
        if (fromTargetRank >= fromActorRank) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'auth.errors.cannotRevokeEqualOrHigher',
          });
        }
        // Pull the bindings to mirror. Even if mirrorRoles=false we
        // still need the count for the audit log.
        const fromBindings = await tx
          .select({
            id: s.memberRoleBindings.id,
            roleId: s.memberRoleBindings.roleId,
            roleRank: s.roles.rank,
          })
          .from(s.memberRoleBindings)
          .innerJoin(s.roles, eq(s.roles.id, s.memberRoleBindings.roleId))
          .where(
            and(
              eq(s.memberRoleBindings.memberId, input.memberId),
              eq(s.memberRoleBindings.scopeType, 'store'),
              eq(s.memberRoleBindings.scopeId, input.fromStoreId),
            ),
          );
        if (input.mirrorRoles && fromBindings.length > 0) {
          const toActorRank = await getActorMaxRankInStore(
            tx,
            orgId,
            ctx.session!.userId,
            input.toStoreId,
          );
          // Each role being mirrored must be strictly below the actor's
          // rank in the destination — same rule as grantRole.
          for (const b of fromBindings) {
            if (b.roleRank >= toActorRank) {
              throw new TRPCError({
                code: 'FORBIDDEN',
                message: 'auth.errors.cannotGrantEqualOrHigher',
              });
            }
          }
        }
        // Inline the detach-from + (optionally mirror to + assign-to)
        // in this single tx. If anything fails, the whole transfer
        // rolls back.

        // 1. Mirror role bindings into target if requested. Done first
        //    so we never leave the member dangling without authority
        //    if the from-side delete somehow fails after.
        let mirrored = 0;
        if (input.mirrorRoles) {
          for (const b of fromBindings) {
            // Idempotent: a binding for the destination might already
            // exist (e.g. a previous transfer attempt). Skip duplicates.
            const existing = await tx.query.memberRoleBindings.findFirst({
              where: (r, { eq: eq2, and: and2 }) =>
                and2(
                  eq2(r.memberId, member.id),
                  eq2(r.roleId, b.roleId),
                  eq2(r.scopeType, 'store'),
                  eq2(r.scopeId, input.toStoreId),
                ),
            });
            if (!existing) {
              await tx.insert(s.memberRoleBindings).values({
                memberId: member.id,
                roleId: b.roleId,
                scopeType: 'store',
                scopeId: input.toStoreId,
                grantedBy: ctx.session!.userId,
              });
              mirrored++;
            }
          }
        }

        // 2. Assign target store (idempotent via onConflictDoNothing).
        await tx
          .insert(s.memberStoreAssignments)
          .values({
            memberId: member.id,
            storeId: input.toStoreId,
            assignedBy: ctx.session!.userId,
          })
          .onConflictDoNothing();

        // 3. Delete from-side bindings + overrides + MSA. Same as the
        //    detach mutation, but we DON'T re-check the last-store
        //    guard because we've just attached the destination — the
        //    member is guaranteed to still belong to ≥1 store.
        const revokedBindings = await tx
          .delete(s.memberRoleBindings)
          .where(
            and(
              eq(s.memberRoleBindings.memberId, member.id),
              eq(s.memberRoleBindings.scopeType, 'store'),
              eq(s.memberRoleBindings.scopeId, input.fromStoreId),
            ),
          )
          .returning({ id: s.memberRoleBindings.id });
        const revokedOverrides = await tx
          .delete(s.memberPermissionOverrides)
          .where(
            and(
              eq(s.memberPermissionOverrides.memberId, member.id),
              eq(s.memberPermissionOverrides.scopeType, 'store'),
              eq(s.memberPermissionOverrides.scopeId, input.fromStoreId),
            ),
          )
          .returning({ id: s.memberPermissionOverrides.id });
        await tx
          .delete(s.memberStoreAssignments)
          .where(
            and(
              eq(s.memberStoreAssignments.memberId, member.id),
              eq(s.memberStoreAssignments.storeId, input.fromStoreId),
            ),
          );
        await auditAdmin(
          tx,
          ctx,
          'admin.memberTransferStore',
          'member',
          member.id,
          {
            ...input,
            mirrored,
            revokedBindings: revokedBindings.length,
            revokedOverrides: revokedOverrides.length,
          },
        );
        broadcastPeople(orgId);
        return {
          ok: true,
          mirrored,
          revokedBindings: revokedBindings.length,
          revokedOverrides: revokedOverrides.length,
        };
      });
    }),

  memberRemove: authedProcedure.input(MemberRemoveInputSchema).mutation(async ({ ctx, input }) => {
    // M3.3: full member-from-org delete is org-tier — it cascade-drops
    // every binding and assignment. Per-store removal lives in
    // memberDetachFromStore (still requireAdmin + C2).
    requireOrgAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      const member = await tx.query.members.findFirst({
        where: (m, { eq: eq2, and: and2 }) =>
          and2(eq2(m.id, input.memberId), eq2(m.orgId, orgId)),
      });
      if (!member) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.memberNotFound' });
      }
      // Same self-protection — don't let an admin remove themselves.
      if (member.userId === ctx.session!.userId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'admin.errors.cannotRemoveSelf',
        });
      }
      // Rank gate — refuse to remove a member whose highest role rank
      // is ≥ actor's. Without this an admin (rank 80) could remove
      // another admin (rank 80) by deleting the member row, which
      // cascade-drops their bindings and ends up the same as a revoke.
      const targetMaxRank = await getActorMaxRank(tx, orgId, member.userId);
      const actorRank = await getActorMaxRank(tx, orgId, ctx.session!.userId);
      if (targetMaxRank >= actorRank && targetMaxRank > 0) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'auth.errors.cannotRevokeEqualOrHigher',
        });
      }
      // Last-admin guard. If the target is admin-level and they're
      // the only admin, refuse.
      if (targetMaxRank >= ADMIN_RANK_THRESHOLD) {
        const adminCount = await countAdminsInOrg(tx, orgId);
        if (adminCount <= 1) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'admin.errors.cannotRemoveLastAdmin',
          });
        }
      }
      // Cascading deletes on member_role_bindings via FK ON DELETE CASCADE.
      // member_store_assignments cascades through the migration's FK.
      await tx.delete(s.members).where(eq(s.members.id, input.memberId));
      broadcastPeople(orgId);
      return { ok: true };
    });
  }),

  // ============ ROLES ============

  roleList: authedProcedure.query(async ({ ctx }) => {
    requireAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      const roles = await tx
        .select({
          id: s.roles.id,
          slug: s.roles.slug,
          name: s.roles.name,
          description: s.roles.description,
          isBuiltIn: s.roles.isBuiltIn,
          rank: s.roles.rank,
        })
        .from(s.roles)
        .where(eq(s.roles.orgId, orgId))
        .orderBy(desc(s.roles.rank));
      const counts = await tx
        .select({
          roleId: s.rolePermissions.roleId,
          n: sql<number>`count(*)::int`,
        })
        .from(s.rolePermissions)
        .innerJoin(s.roles, eq(s.roles.id, s.rolePermissions.roleId))
        .where(eq(s.roles.orgId, orgId))
        .groupBy(s.rolePermissions.roleId);
      const countByRole = new Map(counts.map((c) => [c.roleId, c.n]));
      return roles.map((r) => ({
        ...r,
        permissionCount: countByRole.get(r.id) ?? 0,
      }));
    });
  }),

  /**
   * Per-role permission breakdown — used by the new Permissions screen.
   * Returns the role + the explicit list of permission keys it grants.
   */
  roleDetail: authedProcedure
    .input(z.object({ roleSlug: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const role = await tx.query.roles.findFirst({
          where: (r, { eq: eq2, and: and2 }) =>
            and2(eq2(r.orgId, orgId), eq2(r.slug, input.roleSlug)),
        });
        if (!role) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.roleNotFound' });
        }
        const perms = await tx
          .select({ key: s.rolePermissions.permissionKey })
          .from(s.rolePermissions)
          .where(eq(s.rolePermissions.roleId, role.id));
        // B1 (2026-05-06): assignees grouped by binding scope.
        //   - global bindings → "Org-level" bucket
        //   - store bindings → one bucket per store
        // Powers the "who has this role where" drill-down in the
        // Roles screen so a chain owner can answer "who runs each
        // store?" at a glance.
        const bindings = await tx
          .select({
            bindingId: s.memberRoleBindings.id,
            memberId: s.memberRoleBindings.memberId,
            scopeType: s.memberRoleBindings.scopeType,
            scopeId: s.memberRoleBindings.scopeId,
            displayName: s.users.displayName,
            avatarUrl: s.users.avatarUrl,
            tgUsername: s.users.tgUsername,
            storeName: s.stores.name,
          })
          .from(s.memberRoleBindings)
          .innerJoin(s.members, eq(s.members.id, s.memberRoleBindings.memberId))
          .innerJoin(s.users, eq(s.users.id, s.members.userId))
          // Left join: global bindings have no store, but we still
          // want one row per binding (the FE buckets them into
          // "Org-level" when storeName is null).
          .leftJoin(s.stores, eq(s.stores.id, s.memberRoleBindings.scopeId))
          .where(
            and(
              eq(s.memberRoleBindings.roleId, role.id),
              eq(s.members.orgId, orgId),
              eq(s.members.status, 'active'),
            ),
          );
        return {
          id: role.id,
          slug: role.slug,
          name: role.name,
          description: role.description,
          isBuiltIn: role.isBuiltIn,
          rank: role.rank,
          permissions: perms.map((p) => p.key),
          assignees: bindings.map((b) => ({
            bindingId: b.bindingId,
            memberId: b.memberId,
            displayName: b.displayName,
            avatarUrl: b.avatarUrl,
            tgUsername: b.tgUsername,
            scopeType: b.scopeType as 'global' | 'store',
            scopeId: b.scopeId,
            storeName: b.storeName,
          })),
        };
      });
    }),

  /**
   * Full permission catalog — global static dictionary keyed by
   * `domain.action`. Powers the role-permission editor matrix
   * (added 2026-05-05). Returns rows even when the actor's org has
   * never used a key, since the dictionary is org-independent.
   */
  permissionList: authedProcedure.query(async ({ ctx }) => {
    requireAdmin(ctx.session!.permissions);
    return ctx.db
      .select({
        key: s.permissions.key,
        description: s.permissions.description,
      })
      .from(s.permissions)
      .orderBy(s.permissions.key);
  }),

  /**
   * Create a CUSTOM role (added 2026-05-05).
   *
   * Rules:
   *   - slug must be unique within the org and lowercase-kebab-only
   *   - rank must be STRICTLY less than the actor's max rank, otherwise
   *     an admin (rank 80) could create a rank-99 role and grant it to
   *     themselves, escalating to super_admin
   *   - permissionKeys must all exist in the global permissions
   *     dictionary (silent-drop prevents typos from creating roles
   *     that look right but actually grant nothing)
   *   - is_built_in is always FALSE for created roles — built-ins are
   *     shipped only via the seed script
   *
   * Idempotent on slug — if a role with this slug already exists in
   * the org, returns its id without creating a duplicate. (Custom-
   * roles UI re-firing create on a slow network is a real risk.)
   */
  roleCreate: authedProcedure
    .input(
      z.object({
        slug: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9-]+$/, 'lowercase letters, digits, hyphens only'),
        name: z.string().min(1).max(100),
        description: z.string().max(500).optional().nullable(),
        rank: z.number().int().min(1).max(99),
        permissionKeys: z.array(z.string().min(1).max(100)).default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // M3.3: role catalog is org-wide; only org.admin can mint roles.
      requireOrgAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const actorRank = await getActorMaxRank(tx, orgId, ctx.session!.userId);
        if (input.rank >= actorRank) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'auth.errors.cannotGrantEqualOrHigher',
          });
        }
        // Idempotency: if the slug already exists, return it.
        const existing = await tx.query.roles.findFirst({
          where: (r, { eq: eq2, and: and2 }) =>
            and2(eq2(r.orgId, orgId), eq2(r.slug, input.slug)),
        });
        if (existing) {
          return { id: existing.id, created: false };
        }
        const [created] = await tx
          .insert(s.roles)
          .values({
            orgId,
            slug: input.slug,
            name: input.name,
            description: input.description ?? null,
            rank: input.rank,
            isBuiltIn: false,
          })
          .returning();
        if (input.permissionKeys.length > 0) {
          // Filter against the dictionary so a typo doesn't silently
          // create a half-broken role.
          const validKeys = await tx.query.permissions.findMany({
            where: (p, { inArray: ia }) => ia(p.key, input.permissionKeys),
          });
          if (validKeys.length > 0) {
            await tx
              .insert(s.rolePermissions)
              .values(validKeys.map((p) => ({ roleId: created!.id, permissionKey: p.key })))
              .onConflictDoNothing();
          }
        }
        await auditAdmin(tx, ctx, 'admin.role.create', 'role', created!.id, input);
        broadcastPeople(orgId);
        return { id: created!.id, created: true };
      });
    }),

  /**
   * Edit a role's mutable fields. Built-in roles are partially locked:
   *   - slug is immutable (so existing bindings keep working)
   *   - rank is immutable (so the rank-gate semantics stay stable)
   *   - name / description / permissionKeys CAN change (admins
   *     legitimately want to rename "manager" or add a permission)
   * For custom roles, all fields editable except slug.
   *
   * permissionKeys (when provided) is treated as a FULL replacement.
   */
  roleUpdate: authedProcedure
    .input(
      z.object({
        roleId: UuidSchema,
        name: z.string().min(1).max(100).optional(),
        description: z.string().max(500).optional().nullable(),
        rank: z.number().int().min(1).max(99).optional(),
        permissionKeys: z.array(z.string().min(1).max(100)).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireOrgAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const role = await tx.query.roles.findFirst({
          where: (r, { eq: eq2, and: and2 }) =>
            and2(eq2(r.id, input.roleId), eq2(r.orgId, orgId)),
        });
        if (!role) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.roleNotFound' });
        }
        const actorRank = await getActorMaxRank(tx, orgId, ctx.session!.userId);
        // Rank gate — both the existing rank AND the proposed new rank
        // must be strictly below the actor's rank. Without the existing-
        // rank check, an admin (80) could "edit" super_admin (100) by
        // setting its rank to 50 and then grant it to themselves.
        if (role.rank >= actorRank) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'auth.errors.cannotGrantEqualOrHigher',
          });
        }
        if (input.rank !== undefined && input.rank >= actorRank) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'auth.errors.cannotGrantEqualOrHigher',
          });
        }
        const patch: Record<string, unknown> = {};
        if (input.name !== undefined) patch.name = input.name;
        if (input.description !== undefined) patch.description = input.description;
        // Built-ins keep their rank (anchors the rank-gate ladder).
        if (input.rank !== undefined && !role.isBuiltIn) patch.rank = input.rank;
        if (Object.keys(patch).length > 0) {
          await tx.update(s.roles).set(patch).where(eq(s.roles.id, role.id));
        }
        if (input.permissionKeys !== undefined) {
          // Replace permissions atomically: delete existing, insert new.
          await tx.delete(s.rolePermissions).where(eq(s.rolePermissions.roleId, role.id));
          if (input.permissionKeys.length > 0) {
            const validKeys = await tx.query.permissions.findMany({
              where: (p, { inArray: ia }) => ia(p.key, input.permissionKeys!),
            });
            if (validKeys.length > 0) {
              await tx
                .insert(s.rolePermissions)
                .values(validKeys.map((p) => ({ roleId: role.id, permissionKey: p.key })))
                .onConflictDoNothing();
            }
          }
        }
        await auditAdmin(tx, ctx, 'admin.role.update', 'role', role.id, input);
        broadcastPeople(orgId);
        return { ok: true };
      });
    }),

  /**
   * Delete a CUSTOM role. Built-ins are not deletable (they anchor the
   * rank ladder + are referenced by seeded fixtures). Roles with active
   * member bindings are blocked — admin must revoke first, otherwise
   * we'd orphan permissions on real users.
   */
  roleDelete: authedProcedure
    .input(z.object({ roleId: UuidSchema }))
    .mutation(async ({ ctx, input }) => {
      requireOrgAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const role = await tx.query.roles.findFirst({
          where: (r, { eq: eq2, and: and2 }) =>
            and2(eq2(r.id, input.roleId), eq2(r.orgId, orgId)),
        });
        if (!role) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.roleNotFound' });
        }
        if (role.isBuiltIn) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'admin.errors.cannotDeleteBuiltinRole',
          });
        }
        const actorRank = await getActorMaxRank(tx, orgId, ctx.session!.userId);
        if (role.rank >= actorRank) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'auth.errors.cannotGrantEqualOrHigher',
          });
        }
        const bindings = await tx.query.memberRoleBindings.findMany({
          where: (b, { eq: eq2 }) => eq2(b.roleId, role.id),
        });
        if (bindings.length > 0) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'admin.errors.roleHasBindings',
          });
        }
        // Hard delete — `auth.role_permissions` cascades from `auth.roles`.
        await tx.delete(s.roles).where(eq(s.roles.id, role.id));
        await auditAdmin(tx, ctx, 'admin.role.delete', 'role', role.id, input);
        broadcastPeople(orgId);
        return { ok: true };
      });
    }),

  // ============ MEMBER PERMISSION OVERRIDES (added 2026-05-05) ============
  //
  // These let an admin tweak a single member's permissions without
  // creating a whole new role. Two staff with the same role can end
  // up with different effective permissions via 'allow' / 'deny'
  // overrides. See `auth.member_permission_overrides` schema.

  /**
   * Read the role-derived baseline + the override layer for one member.
   * Returns:
   *   roleKeys     — union of the member's role permissions
   *   overrides    — explicit per-member rows (allow + deny + scope)
   *   effective    — final set after layering overrides on roleKeys
   *
   * UI shows roleKeys as a grayed-out "from role" badge and
   * overrides as the toggleable surface.
   */
  memberPermissionsList: authedProcedure
    .input(z.object({ memberId: UuidSchema }))
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const member = await tx.query.members.findFirst({
          where: (m, { eq: eq2, and: and2 }) =>
            and2(eq2(m.id, input.memberId), eq2(m.orgId, orgId)),
        });
        if (!member) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.memberNotFound' });
        }
        // Role-derived perms (across all bindings).
        const bindings = await tx
          .select({ roleId: s.memberRoleBindings.roleId })
          .from(s.memberRoleBindings)
          .where(eq(s.memberRoleBindings.memberId, member.id));
        const rolePerms =
          bindings.length > 0
            ? await tx
                .select({ key: s.rolePermissions.permissionKey })
                .from(s.rolePermissions)
                .where(
                  inArray(
                    s.rolePermissions.roleId,
                    bindings.map((b) => b.roleId),
                  ),
                )
            : [];
        const roleKeys = [...new Set(rolePerms.map((r) => r.key))];
        // Active overrides only (non-expired).
        const rawOverrides = await tx
          .select()
          .from(s.memberPermissionOverrides)
          .where(eq(s.memberPermissionOverrides.memberId, member.id));
        const now = new Date();
        const overrides = rawOverrides
          .filter((o) => !o.expiresAt || o.expiresAt > now)
          .map((o) => ({
            id: o.id,
            permissionKey: o.permissionKey,
            effect: o.effect as 'allow' | 'deny',
            scopeType: o.scopeType as 'global' | 'store',
            scopeId: o.scopeId,
            expiresAt: o.expiresAt?.toISOString() ?? null,
          }));
        const effective = new Set(roleKeys);
        for (const o of overrides) {
          if (o.effect === 'allow') effective.add(o.permissionKey);
        }
        for (const o of overrides) {
          if (o.effect === 'deny') effective.delete(o.permissionKey);
        }
        return {
          memberId: member.id,
          roleKeys,
          overrides,
          effective: [...effective].sort(),
        };
      });
    }),

  /**
   * Set (or replace) a single override row.
   *
   *   memberPermissionSet({ memberId, permissionKey, effect: 'allow'|'deny',
   *                         scopeType, scopeId? })
   *
   * Idempotent on (member, permissionKey, scope) — overwrites the
   * effect if the row already exists. Use `memberPermissionRevoke` to
   * remove a row entirely (different from setting effect='allow' on a
   * permission the role already grants — those mean different things
   * in audit).
   *
   * Rank gate: the actor must outrank the target. Without this, an
   * admin (rank 80) could deny `users.manage` on another admin (80)
   * and effectively neuter them. The same gate already protects
   * grant/revoke role.
   */
  memberPermissionSet: authedProcedure
    .input(
      z.object({
        memberId: UuidSchema,
        permissionKey: z.string().min(1).max(100),
        effect: z.enum(['allow', 'deny']),
        scopeType: z.enum(['global', 'store']).default('global'),
        scopeId: UuidSchema.optional().nullable(),
        expiresAt: z.string().datetime().optional().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const member = await tx.query.members.findFirst({
          where: (m, { eq: eq2, and: and2 }) =>
            and2(eq2(m.id, input.memberId), eq2(m.orgId, orgId)),
        });
        if (!member) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.memberNotFound' });
        }
        // Scope coherence — store scope requires a store id (validated
        // up-front so the C2 check has a concrete storeId to look at).
        if (input.scopeType === 'store') {
          if (!input.scopeId) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'admin.errors.scopeStoreIdRequired',
            });
          }
          const targetStore = await tx.query.stores.findFirst({
            where: (st, { eq: eq2, and: and2 }) =>
              and2(eq2(st.id, input.scopeId!), eq2(st.orgId, orgId)),
          });
          if (!targetStore) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'admin.errors.storeNotFound',
            });
          }
        }
        // C2 (2026-05-06): store-scoped overrides require admin-of-store.
        // Global overrides are inherently org-wide and only globally-
        // privileged admins should be able to set those.
        if (input.scopeType === 'store' && input.scopeId) {
          const allowed = await getActorAdminStoreIds(tx, orgId, ctx.session!.userId);
          if (!allowed.includes(input.scopeId)) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'admin.errors.notAdminOfStore',
            });
          }
        }
        // C1 (2026-05-06): rank gate evaluated IN the override's scope.
        // Setting a store-scoped allow/deny on Store A uses the actor's
        // rank-in-A and the target's rank-in-A. Global overrides keep
        // using global rank.
        const targetRank =
          input.scopeType === 'store' && input.scopeId
            ? await getActorMaxRankInStore(tx, orgId, member.userId, input.scopeId)
            : await getActorMaxRank(tx, orgId, member.userId);
        const actorRank =
          input.scopeType === 'store' && input.scopeId
            ? await getActorMaxRankInStore(tx, orgId, ctx.session!.userId, input.scopeId)
            : await getActorMaxRank(tx, orgId, ctx.session!.userId);
        if (targetRank >= actorRank) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'auth.errors.cannotGrantEqualOrHigher',
          });
        }
        // Validate permission key exists in the dictionary.
        const perm = await tx.query.permissions.findFirst({
          where: (p, { eq: eq2 }) => eq2(p.key, input.permissionKey),
        });
        if (!perm) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'admin.errors.permissionNotFound',
          });
        }
        // Upsert by (member, key, scope). Postgres treats NULL as
        // distinct in plain UNIQUE constraints, so we hand-rolled the
        // unique index in the migration. The query plan still matches
        // it via the 4-tuple match below.
        const existing = await tx.query.memberPermissionOverrides.findFirst({
          where: (o, { eq: eq2, and: and2 }) =>
            and2(
              eq2(o.memberId, member.id),
              eq2(o.permissionKey, input.permissionKey),
              eq2(o.scopeType, input.scopeType),
              input.scopeId
                ? eq2(o.scopeId, input.scopeId)
                : sql`${o.scopeId} IS NULL`,
            ),
        });
        if (existing) {
          await tx
            .update(s.memberPermissionOverrides)
            .set({
              effect: input.effect,
              expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
              grantedBy: ctx.session!.userId,
            })
            .where(eq(s.memberPermissionOverrides.id, existing.id));
        } else {
          await tx.insert(s.memberPermissionOverrides).values({
            memberId: member.id,
            permissionKey: input.permissionKey,
            effect: input.effect,
            scopeType: input.scopeType,
            scopeId: input.scopeId ?? null,
            grantedBy: ctx.session!.userId,
            expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          });
        }
        await auditAdmin(
          tx,
          ctx,
          `admin.memberPermission.${input.effect}`,
          'permission',
          member.id,
          input,
        );
        broadcastPeople(orgId);
        return { ok: true };
      });
    }),

  /**
   * Remove a per-member override row entirely. After revocation the
   * member's effective permissions for this key revert to whatever
   * their role would grant (which might be "yes" or "no" — not the
   * caller's problem here).
   */
  memberPermissionRevoke: authedProcedure
    .input(
      z.object({
        memberId: UuidSchema,
        permissionKey: z.string().min(1).max(100),
        scopeType: z.enum(['global', 'store']).default('global'),
        scopeId: UuidSchema.optional().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const member = await tx.query.members.findFirst({
          where: (m, { eq: eq2, and: and2 }) =>
            and2(eq2(m.id, input.memberId), eq2(m.orgId, orgId)),
        });
        if (!member) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.memberNotFound' });
        }
        // C2 (2026-05-06): symmetric to `memberPermissionSet`. Store-
        // scoped revoke requires admin-of-store; global revoke is org-
        // wide so global admin authority is required (the requireAdmin
        // call above checks `users.manage` which is sufficient).
        if (input.scopeType === 'store' && input.scopeId) {
          const allowed = await getActorAdminStoreIds(tx, orgId, ctx.session!.userId);
          if (!allowed.includes(input.scopeId)) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'admin.errors.notAdminOfStore',
            });
          }
        }
        // C1 (2026-05-06): rank gate evaluated in scope.
        const targetRank =
          input.scopeType === 'store' && input.scopeId
            ? await getActorMaxRankInStore(tx, orgId, member.userId, input.scopeId)
            : await getActorMaxRank(tx, orgId, member.userId);
        const actorRank =
          input.scopeType === 'store' && input.scopeId
            ? await getActorMaxRankInStore(tx, orgId, ctx.session!.userId, input.scopeId)
            : await getActorMaxRank(tx, orgId, ctx.session!.userId);
        if (targetRank >= actorRank) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'auth.errors.cannotGrantEqualOrHigher',
          });
        }
        await tx
          .delete(s.memberPermissionOverrides)
          .where(
            and(
              eq(s.memberPermissionOverrides.memberId, member.id),
              eq(s.memberPermissionOverrides.permissionKey, input.permissionKey),
              eq(s.memberPermissionOverrides.scopeType, input.scopeType),
              input.scopeId
                ? eq(s.memberPermissionOverrides.scopeId, input.scopeId)
                : sql`${s.memberPermissionOverrides.scopeId} IS NULL`,
            ),
          );
        await auditAdmin(
          tx,
          ctx,
          'admin.memberPermission.revoke',
          'permission',
          member.id,
          input,
        );
        broadcastPeople(orgId);
        return { ok: true };
      });
    }),

  grantRole: authedProcedure.input(GrantRoleInputSchema).mutation(async ({ ctx, input }) => {
    // Accept either the legacy coarse `users.manage` or the new
    // granular `users.grant_role` permission.
    requireOneOf(ctx.session!.permissions, ['users.grant_role', 'users.manage']);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      const member = await tx.query.members.findFirst({
        where: (m, { eq: eq2, and: and2 }) =>
          and2(eq2(m.orgId, orgId), eq2(m.userId, input.userId)),
      });
      if (!member) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.memberNotFound' });
      }
      const role = await tx.query.roles.findFirst({
        where: (r, { eq: eq2, and: and2 }) =>
          and2(eq2(r.orgId, orgId), eq2(r.slug, input.roleSlug)),
      });
      if (!role) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.roleNotFound' });
      }

      // STORE-SCOPE REQUIREMENT (added 2026-05-05).
      //
      // Roles below admin tier (rank < 80) are inherently per-store —
      // a manager manages SPECIFIC stores; a purchaser/staff WORKS at
      // SPECIFIC stores. We refuse to create global bindings for them
      // because that's the path by which a "manager of everywhere"
      // accidentally lands in the DB and the Approval queue starts
      // showing every org's session to every manager (audit found
      // 2026-05-05 — see docs/role-design-2026-05-05.md). admin (80)
      // and super_admin (100) stay 'global' since they ARE org-tier.
      if (role.rank < ADMIN_RANK && input.scopeType !== 'store') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'admin.errors.scopeStoreIdRequired',
        });
      }

      // SECURITY (2026-05-04): if the binding is store-scoped, verify
      // the store belongs to the actor's org. Without this an admin in
      // org A could grant a role scoped to a store in org B by passing
      // its UUID — cross-tenant injection.
      if (input.scopeType === 'store') {
        if (!input.scopeId) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'admin.errors.scopeStoreIdRequired',
          });
        }
        const targetStore = await tx.query.stores.findFirst({
          where: (st, { eq: eq2, and: and2 }) =>
            and2(eq2(st.id, input.scopeId!), eq2(st.orgId, orgId)),
        });
        if (!targetStore) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'admin.errors.storeNotFound',
          });
        }
      }

      // C2 (2026-05-06): store-scoped admins can only manage members
      // of THEIR stores. A "manager of Store A" who tries to grant
      // "staff of Store B" must be refused: they have no authority
      // there. Global admins pass through (their adminStoreIds is
      // the full org list).
      //
      // We check this BEFORE the rank gate so the FORBIDDEN message
      // points at the real problem — if a store-scoped manager is
      // trying to act on a foreign store, "you don't manage that
      // store" is more useful than "your rank is too low."
      if (input.scopeType === 'store' && input.scopeId) {
        const allowed = await getActorAdminStoreIds(tx, orgId, ctx.session!.userId);
        if (!allowed.includes(input.scopeId)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'admin.errors.notAdminOfStore',
          });
        }
      }

      // C1 (2026-05-06): rank gate — "no equal/higher grants", but
      // evaluated IN THE SCOPE the binding is being created in.
      //
      //   - 'global' grant → use global getActorMaxRank (admin/super_admin
      //     are themselves global, so global rank is the right yardstick).
      //   - 'store' grant → use getActorMaxRankInStore: a manager rank-50
      //     in Store A cannot grant rank-50 INTO Store A, AND cannot
      //     grant ANYTHING into Store B (where their effective rank is 0
      //     unless they hold a global binding).
      //
      // The earlier code used global rank for both branches, which let
      // a store-scoped manager smuggle their authority across stores.
      const actorRank =
        input.scopeType === 'store' && input.scopeId
          ? await getActorMaxRankInStore(tx, orgId, ctx.session!.userId, input.scopeId)
          : await getActorMaxRank(tx, orgId, ctx.session!.userId);
      if (role.rank >= actorRank) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'auth.errors.cannotGrantEqualOrHigher',
        });
      }

      // Idempotency check (fixed 2026-05-05 — audit found the prior
      // version omitted scopeId, so granting "manager of store A" then
      // "manager of store B" to the same member would short-circuit
      // and leave only the A binding in place).
      //
      // For 'global' scope the (member, role, 'global') tuple is enough
      // — there's no scopeId to match. For 'store' scope we MUST
      // additionally match scopeId so distinct stores get distinct
      // bindings. Without that, the second call wrongly returns the
      // first store's binding as "already exists".
      const existing = await tx.query.memberRoleBindings.findFirst({
        where: (b, { eq: eq2, and: and2 }) => {
          const base = [
            eq2(b.memberId, member.id),
            eq2(b.roleId, role.id),
            eq2(b.scopeType, input.scopeType),
          ];
          if (input.scopeType === 'store' && input.scopeId) {
            base.push(eq2(b.scopeId, input.scopeId));
          }
          return and2(...base);
        },
      });
      if (existing) return { granted: false, bindingId: existing.id };
      const [created] = await tx
        .insert(s.memberRoleBindings)
        .values({
          memberId: member.id,
          roleId: role.id,
          scopeType: input.scopeType,
          scopeId: input.scopeId ?? null,
          grantedBy: ctx.session!.userId,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        })
        .returning();
      // Broadcast so other admins viewing the People section see the
      // new binding without manual refresh.
      hub.publish(orgId, { type: 'people.changed', orgId });
      return { granted: true, bindingId: created!.id };
    });
  }),

  revokeRole: authedProcedure.input(RevokeRoleInputSchema).mutation(async ({ ctx, input }) => {
    requireOneOf(ctx.session!.permissions, ['users.revoke_role', 'users.manage']);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      const binding = await tx
        .select({
          id: s.memberRoleBindings.id,
          memberOrgId: s.members.orgId,
          memberUserId: s.members.userId,
          roleSlug: s.roles.slug,
          roleRank: s.roles.rank,
          scopeType: s.memberRoleBindings.scopeType,
          scopeId: s.memberRoleBindings.scopeId,
        })
        .from(s.memberRoleBindings)
        .innerJoin(s.members, eq(s.members.id, s.memberRoleBindings.memberId))
        .innerJoin(s.roles, eq(s.roles.id, s.memberRoleBindings.roleId))
        .where(eq(s.memberRoleBindings.id, input.bindingId))
        .limit(1);
      if (binding.length === 0 || binding[0]!.memberOrgId !== orgId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.bindingNotFound' });
      }
      const targetSlug = binding[0]!.roleSlug;
      const targetRank = binding[0]!.roleRank;
      const bindingScopeType = binding[0]!.scopeType;
      const bindingScopeId = binding[0]!.scopeId;
      // Self-protection: don't let an admin revoke their own super_admin /
      // admin roles. The CLI is the escape hatch for true breakage.
      if (
        binding[0]!.memberUserId === ctx.session!.userId &&
        (targetSlug === 'super_admin' || targetSlug === 'admin')
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'admin.errors.cannotRevokeSelfAdmin',
        });
      }
      // C2 (2026-05-06): if the binding being revoked is store-scoped,
      // the actor must be admin-of-that-store. Without this gate a
      // manager-of-A could revoke a manager-of-B binding and silently
      // demote staff in stores they have no business touching.
      if (bindingScopeType === 'store' && bindingScopeId) {
        const allowed = await getActorAdminStoreIds(tx, orgId, ctx.session!.userId);
        if (!allowed.includes(bindingScopeId)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'admin.errors.notAdminOfStore',
          });
        }
      }
      // C1 (2026-05-06): rank gate — same logic as grant, evaluated in
      // the binding's scope. A manager-rank-50 in Store A revoking a
      // manager-rank-50 in Store A: equal rank, refused. Revoking a
      // staff-rank-10 in Store A: 50 > 10, allowed. Cross-store is
      // already blocked above by the C2 check.
      const actorRank =
        bindingScopeType === 'store' && bindingScopeId
          ? await getActorMaxRankInStore(tx, orgId, ctx.session!.userId, bindingScopeId)
          : await getActorMaxRank(tx, orgId, ctx.session!.userId);
      if (targetRank >= actorRank) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'auth.errors.cannotRevokeEqualOrHigher',
        });
      }
      // Last-admin guard. If revoking this binding would drop the
      // org's admin-rank head-count to zero, refuse. Without this an
      // org could end up with no manageable admin (only super_admin
      // could fix from CLI) — a real footgun for a SaaS rollout.
      if (targetRank >= ADMIN_RANK_THRESHOLD) {
        const adminCount = await countAdminsInOrg(tx, orgId);
        // The target is currently counted; the revoke would remove
        // them — so we need >1 to still have ≥1 left after.
        if (adminCount <= 1) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'admin.errors.cannotRemoveLastAdmin',
          });
        }
      }
      await tx
        .delete(s.memberRoleBindings)
        .where(eq(s.memberRoleBindings.id, input.bindingId));
      hub.publish(orgId, { type: 'people.changed', orgId });
      return { revoked: true };
    });
  }),

  // ============ STORES ============

  storeList: authedProcedure
    .input(z.object({ includeArchived: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const includeArchived = input?.includeArchived ?? false;
        // SECURITY (2026-05-04): default behavior excludes soft-deleted
        // stores. Previously every storeList call returned them and the
        // FE had no signal to hide. Now: pass `includeArchived: true`
        // to see them (e.g. for a "show archived" toggle in admin).
        // Left-join roles so we can return the default role's slug
        // alongside the store row — saves the FE a second query.
        const rows = await tx
          .select({
            id: s.stores.id,
            name: s.stores.name,
            code: s.stores.code,
            address: s.stores.address,
            timezone: s.stores.timezone,
            isActive: s.stores.isActive,
            createdAt: s.stores.createdAt,
            defaultRoleId: s.stores.defaultRoleId,
            defaultRoleSlug: s.roles.slug,
            defaultRoleName: s.roles.name,
          })
          .from(s.stores)
          .leftJoin(s.roles, eq(s.roles.id, s.stores.defaultRoleId))
          .where(
            and(
              eq(s.stores.orgId, orgId),
              ...(includeArchived ? [] : [eq(s.stores.isActive, true)]),
            ),
          )
          .orderBy(s.stores.name);
        return rows;
      });
    }),

  storeCreate: authedProcedure.input(StoreCreateInputSchema).mutation(async ({ ctx, input }) => {
    // M3.3: creating a store is org-level (adds to the chain).
    requireOrgAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      const [created] = await tx
        .insert(s.stores)
        .values({
          orgId,
          name: input.name,
          code: input.code ?? null,
          address: input.address ?? null,
          timezone: input.timezone ?? null,
        })
        .returning();
      await auditAdmin(tx, ctx, 'admin.store.create', 'store', created!.id, input);
      broadcastCatalog(orgId, 'store');
      return { id: created!.id };
    });
  }),

  storeUpdate: authedProcedure.input(StoreUpdateInputSchema).mutation(async ({ ctx, input }) => {
    requireAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      // M3.3 (2026-05-15): per-store admin gate (C2 pattern). Before
      // this the procedure was reachable by any actor with
      // `users.manage`, so a manager-of-A could pass storeId=B and
      // rename Store B. Mirrors the gate already present on
      // memberAssignStore / memberDetachFromStore.
      const allowed = await getActorAdminStoreIds(tx, orgId, ctx.session!.userId);
      if (!allowed.includes(input.storeId)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'admin.errors.notAdminOfStore',
        });
      }
      const existing = await tx.query.stores.findFirst({
        where: (st, { eq: eq2, and: and2 }) =>
          and2(eq2(st.id, input.storeId), eq2(st.orgId, orgId)),
      });
      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.storeNotFound' });
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (input.name !== undefined) patch.name = input.name;
      if (input.code !== undefined) patch.code = input.code;
      if (input.address !== undefined) patch.address = input.address;
      if (input.timezone !== undefined) patch.timezone = input.timezone;
      if (input.isActive !== undefined) patch.isActive = input.isActive;
      // D3: defaultRoleSlug. `null` clears; a string resolves to a
      // role-id (within the actor's org so cross-tenant slugs can't
      // sneak in). We accept by slug rather than role-id to keep the
      // contract human-readable in the FE form.
      if (input.defaultRoleSlug !== undefined) {
        if (input.defaultRoleSlug === null) {
          patch.defaultRoleId = null;
        } else {
          const role = await tx.query.roles.findFirst({
            where: (r, { eq: eq2, and: and2 }) =>
              and2(eq2(r.orgId, orgId), eq2(r.slug, input.defaultRoleSlug!)),
          });
          if (!role) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'admin.errors.roleNotFound',
            });
          }
          // Don't let an admin-tier role be the store default. By
          // contract a store default should be a per-store role; the
          // grantRole gate already refuses non-admin scope='global',
          // so an admin/super_admin default would just bork the
          // invite path.
          if (role.rank >= ADMIN_RANK_THRESHOLD) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'admin.errors.defaultRoleMustBeStoreTier',
            });
          }
          patch.defaultRoleId = role.id;
        }
      }
      await tx.update(s.stores).set(patch).where(eq(s.stores.id, input.storeId));
      await auditAdmin(tx, ctx, 'admin.store.update', 'store', input.storeId, input);
      broadcastCatalog(orgId, 'store');
      return { ok: true };
    });
  }),

  storeDelete: authedProcedure.input(StoreDeleteInputSchema).mutation(async ({ ctx, input }) => {
    // M3.3: deleting a store cascades through every store-scoped row
    // for that location. Org.admin only.
    requireOrgAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      const existing = await tx.query.stores.findFirst({
        where: (st, { eq: eq2, and: and2 }) =>
          and2(eq2(st.id, input.storeId), eq2(st.orgId, orgId)),
      });
      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.storeNotFound' });
      }
      // Soft delete via deleted_at timestamp + isActive=false. Hard delete
      // would cascade through every order_session, run_item_store, etc.
      // — much too destructive for a button tap.
      await tx
        .update(s.stores)
        .set({ isActive: false, deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(s.stores.id, input.storeId));
      await auditAdmin(tx, ctx, 'admin.store.delete', 'store', input.storeId, input);
      broadcastCatalog(orgId, 'store');
      return { ok: true };
    });
  }),

  /**
   * D4 (2026-05-06): clone a store's role bindings into another store.
   *
   * "I just opened Store C — give it the same team shape as Store A"
   * is a recurring request from chains opening new locations. Doing
   * it manually means: list store A's people → for each, grant the
   * same role in store C. Tedious and error-prone.
   *
   * What the clone does:
   *   - For every store-scoped role binding in `sourceStoreId`, create
   *     an equivalent binding in `targetStoreId` (same member, same
   *     role). Existing bindings are skipped (idempotent re-runs).
   *   - When `includeMembers=true`, also assign each source member to
   *     the target store via MSA. Off by default — most chain expansion
   *     wants the SHAPE replicated, staffed by different people.
   *   - Per-binding rank gate: skip (don't fail the whole op) any
   *     binding whose role outranks the actor's rank in the target.
   *     Counted separately and returned so the operator knows.
   *
   * Atomic in one transaction — partial success of "10 cloned, 2
   * skipped (rank), 0 failed" is fine; a transient PG error rolls
   * everything back.
   */
  storeCloneRoles: authedProcedure
    .input(StoreCloneRolesInputSchema)
    .mutation(async ({ ctx, input }) => {
      // M3.3: cloning role bindings across stores spans both source
      // AND target store authority; safer to gate on org.admin.
      requireOrgAdmin(ctx.session!.permissions);
      if (input.sourceStoreId === input.targetStoreId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'admin.errors.transferSameStore',
        });
      }
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const [sourceStore, targetStore] = await Promise.all([
          tx.query.stores.findFirst({
            where: (st, { eq: eq2, and: and2 }) =>
              and2(eq2(st.id, input.sourceStoreId), eq2(st.orgId, orgId)),
          }),
          tx.query.stores.findFirst({
            where: (st, { eq: eq2, and: and2 }) =>
              and2(eq2(st.id, input.targetStoreId), eq2(st.orgId, orgId)),
          }),
        ]);
        if (!sourceStore || !targetStore) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.storeNotFound' });
        }
        // C2: actor must administer BOTH ends. Reading the source's
        // shape AND writing into the target both qualify as admin
        // actions.
        const allowed = await getActorAdminStoreIds(tx, orgId, ctx.session!.userId);
        if (
          !allowed.includes(input.sourceStoreId) ||
          !allowed.includes(input.targetStoreId)
        ) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'admin.errors.notAdminOfStore',
          });
        }
        // Pull source bindings (only store-scoped + active members).
        const sourceBindings = await tx
          .select({
            memberId: s.memberRoleBindings.memberId,
            roleId: s.memberRoleBindings.roleId,
            roleRank: s.roles.rank,
          })
          .from(s.memberRoleBindings)
          .innerJoin(s.roles, eq(s.roles.id, s.memberRoleBindings.roleId))
          .innerJoin(s.members, eq(s.members.id, s.memberRoleBindings.memberId))
          .where(
            and(
              eq(s.memberRoleBindings.scopeType, 'store'),
              eq(s.memberRoleBindings.scopeId, input.sourceStoreId),
              eq(s.members.status, 'active'),
            ),
          );
        const targetActorRank = await getActorMaxRankInStore(
          tx,
          orgId,
          ctx.session!.userId,
          input.targetStoreId,
        );
        let cloned = 0;
        let skippedRank = 0;
        let skippedExisting = 0;
        for (const b of sourceBindings) {
          if (b.roleRank >= targetActorRank) {
            skippedRank++;
            continue;
          }
          const existing = await tx.query.memberRoleBindings.findFirst({
            where: (r, { eq: eq2, and: and2 }) =>
              and2(
                eq2(r.memberId, b.memberId),
                eq2(r.roleId, b.roleId),
                eq2(r.scopeType, 'store'),
                eq2(r.scopeId, input.targetStoreId),
              ),
          });
          if (existing) {
            skippedExisting++;
            continue;
          }
          await tx.insert(s.memberRoleBindings).values({
            memberId: b.memberId,
            roleId: b.roleId,
            scopeType: 'store',
            scopeId: input.targetStoreId,
            grantedBy: ctx.session!.userId,
          });
          cloned++;
        }
        // Optional: also populate the target's MSA from the source's.
        // We skip the unique-constraint dance with onConflictDoNothing.
        let assigned = 0;
        if (input.includeMembers) {
          const sourceMsa = await tx
            .select({ memberId: s.memberStoreAssignments.memberId })
            .from(s.memberStoreAssignments)
            .where(eq(s.memberStoreAssignments.storeId, input.sourceStoreId));
          for (const r of sourceMsa) {
            const inserted = await tx
              .insert(s.memberStoreAssignments)
              .values({
                memberId: r.memberId,
                storeId: input.targetStoreId,
                assignedBy: ctx.session!.userId,
              })
              .onConflictDoNothing()
              .returning({ memberId: s.memberStoreAssignments.memberId });
            if (inserted.length > 0) assigned++;
          }
        }
        await auditAdmin(
          tx,
          ctx,
          'admin.store.cloneRoles',
          'store',
          input.targetStoreId,
          { ...input, cloned, skippedRank, skippedExisting, assigned },
        );
        broadcastPeople(orgId);
        return { ok: true, cloned, skippedRank, skippedExisting, assigned };
      });
    }),

  // ============ CATEGORIES ============

  categoryList: authedProcedure.query(async ({ ctx }) => {
    requireAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      return tx
        .select({
          id: s.categories.id,
          slug: s.categories.slug,
          names: s.categories.names,
          sortIndex: s.categories.sortIndex,
          icon: s.categories.icon,
          isArchived: s.categories.isArchived,
        })
        .from(s.categories)
        .where(eq(s.categories.orgId, orgId))
        .orderBy(s.categories.sortIndex);
    });
  }),

  categoryCreate: authedProcedure.input(CategoryCreateInputSchema).mutation(async ({ ctx, input }) => {
    // M3.3: categories are org-wide (no store_id) — org.admin only.
    requireOrgAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      const [created] = await tx
        .insert(s.categories)
        .values({
          orgId,
          slug: input.slug,
          names: input.names,
          sortIndex: input.sortIndex,
        })
        .returning();
      await auditAdmin(tx, ctx, 'admin.category.create', 'category', created!.id, input);
      broadcastCatalog(orgId, 'category');
      return { id: created!.id };
    });
  }),

  categoryUpdate: authedProcedure.input(CategoryUpdateInputSchema).mutation(async ({ ctx, input }) => {
    requireOrgAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      const existing = await tx.query.categories.findFirst({
        where: (c, { eq: eq2, and: and2 }) =>
          and2(eq2(c.id, input.categoryId), eq2(c.orgId, orgId)),
      });
      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.categoryNotFound' });
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (input.slug !== undefined) patch.slug = input.slug;
      if (input.names !== undefined) patch.names = input.names;
      if (input.sortIndex !== undefined) patch.sortIndex = input.sortIndex;
      if (input.isArchived !== undefined) patch.isArchived = input.isArchived;
      await tx.update(s.categories).set(patch).where(eq(s.categories.id, input.categoryId));
      await auditAdmin(tx, ctx, 'admin.category.update', 'category', input.categoryId, input);
      broadcastCatalog(orgId, 'category');
      return { ok: true };
    });
  }),

  categoryDelete: authedProcedure.input(CategoryDeleteInputSchema).mutation(async ({ ctx, input }) => {
    requireOrgAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      const existing = await tx.query.categories.findFirst({
        where: (c, { eq: eq2, and: and2 }) =>
          and2(eq2(c.id, input.categoryId), eq2(c.orgId, orgId)),
      });
      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.categoryNotFound' });
      }
      await tx
        .update(s.categories)
        .set({ isArchived: true, updatedAt: new Date() })
        .where(eq(s.categories.id, input.categoryId));
      await auditAdmin(tx, ctx, 'admin.category.delete', 'category', input.categoryId, input);
      broadcastCatalog(orgId, 'category');
      return { ok: true };
    });
  }),

  // ============ SKUs ============

  skuList: authedProcedure
    .input(z.object({ includeArchived: z.boolean().default(false) }).optional())
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const includeArchived = input?.includeArchived ?? false;
        return tx
          .select({
            id: s.skus.id,
            categoryId: s.skus.categoryId,
            code: s.skus.code,
            names: s.skus.names,
            unit: s.skus.unit,
            step: s.skus.step,
            imageUrl: s.skus.imageUrl,
            suggestedQty: s.skus.suggestedQty,
            sortIndex: s.skus.sortIndex,
            isArchived: s.skus.isArchived,
          })
          .from(s.skus)
          .where(
            includeArchived
              ? eq(s.skus.orgId, orgId)
              : and(eq(s.skus.orgId, orgId), eq(s.skus.isArchived, false)),
          )
          .orderBy(s.skus.sortIndex);
      });
    }),

  skuCreate: authedProcedure.input(SkuCreateInputSchema).mutation(async ({ ctx, input }) => {
    // M3.3: SKUs are org-wide; only org.admin can mint new ones.
    requireOrgAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      // SECURITY (2026-05-04): verify categoryId belongs to actor's org
      // — otherwise a UUID from another org could attach this SKU to
      // their category (cross-tenant data leak).
      if (input.categoryId) {
        const cat = await tx.query.categories.findFirst({
          where: (c, { eq: eq2, and: and2 }) =>
            and2(eq2(c.id, input.categoryId!), eq2(c.orgId, orgId)),
        });
        if (!cat) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.categoryNotFound' });
        }
      }
      const [created] = await tx
        .insert(s.skus)
        .values({
          orgId,
          categoryId: input.categoryId ?? null,
          code: input.code ?? null,
          names: input.names,
          unit: input.unit,
          step: input.step,
          sortIndex: input.sortIndex,
        })
        .returning();
      await auditAdmin(tx, ctx, 'admin.sku.create', 'sku', created!.id, input);
      broadcastCatalog(orgId, 'sku');
      return { id: created!.id };
    });
  }),

  skuUpdate: authedProcedure.input(SkuUpdateInputSchema).mutation(async ({ ctx, input }) => {
    requireOrgAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      const existing = await tx.query.skus.findFirst({
        where: (k, { eq: eq2, and: and2 }) =>
          and2(eq2(k.id, input.skuId), eq2(k.orgId, orgId)),
      });
      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.skuNotFound' });
      }
      // Cross-tenant gate on categoryId — same as skuCreate.
      if (input.categoryId) {
        const cat = await tx.query.categories.findFirst({
          where: (c, { eq: eq2, and: and2 }) =>
            and2(eq2(c.id, input.categoryId!), eq2(c.orgId, orgId)),
        });
        if (!cat) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.categoryNotFound' });
        }
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (input.categoryId !== undefined) patch.categoryId = input.categoryId;
      if (input.code !== undefined) patch.code = input.code;
      if (input.names !== undefined) patch.names = input.names;
      if (input.unit !== undefined) patch.unit = input.unit;
      if (input.step !== undefined) patch.step = input.step;
      if (input.sortIndex !== undefined) patch.sortIndex = input.sortIndex;
      if (input.isArchived !== undefined) patch.isArchived = input.isArchived;
      await tx.update(s.skus).set(patch).where(eq(s.skus.id, input.skuId));
      await auditAdmin(tx, ctx, 'admin.sku.update', 'sku', input.skuId, input);
      broadcastCatalog(orgId, 'sku');
      return { ok: true };
    });
  }),

  skuDelete: authedProcedure.input(SkuDeleteInputSchema).mutation(async ({ ctx, input }) => {
    requireOrgAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      const existing = await tx.query.skus.findFirst({
        where: (k, { eq: eq2, and: and2 }) =>
          and2(eq2(k.id, input.skuId), eq2(k.orgId, orgId)),
      });
      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.skuNotFound' });
      }
      // Soft delete; hard delete would cascade through every order_item ever
      // referencing this SKU.
      await tx
        .update(s.skus)
        .set({ isArchived: true, updatedAt: new Date() })
        .where(eq(s.skus.id, input.skuId));
      await auditAdmin(tx, ctx, 'admin.sku.delete', 'sku', input.skuId, input);
      // BUG FIX (2026-05-04): missing broadcast — admins on the catalog
      // page would not auto-refresh after archive.
      broadcastCatalog(orgId, 'sku');
      return { ok: true };
    });
  }),

  // ============ SUPPLIERS ============

  supplierList: authedProcedure
    .input(z.object({ includeArchived: z.boolean().default(false) }).optional())
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const includeArchived = input?.includeArchived ?? false;
        return tx
          .select({
            id: s.suppliers.id,
            name: s.suppliers.name,
            contactPhone: s.suppliers.contactPhone,
            contactTg: s.suppliers.contactTg,
            address: s.suppliers.address,
            photoUrl: s.suppliers.photoUrl,
            rating: s.suppliers.rating,
            reliabilityScore: s.suppliers.reliabilityScore,
            priceTrustScore: s.suppliers.priceTrustScore,
            notes: s.suppliers.notes,
            isArchived: s.suppliers.isArchived,
          })
          .from(s.suppliers)
          .where(
            includeArchived
              ? eq(s.suppliers.orgId, orgId)
              : and(eq(s.suppliers.orgId, orgId), eq(s.suppliers.isArchived, false)),
          )
          .orderBy(s.suppliers.name);
      });
    }),

  supplierCreate: authedProcedure.input(SupplierCreateInputSchema).mutation(async ({ ctx, input }) => {
    // M3.3: suppliers are org-wide; only org.admin manages them.
    requireOrgAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      const [created] = await tx
        .insert(s.suppliers)
        .values({
          orgId,
          name: input.name,
          contactPhone: input.contactPhone ?? null,
          contactTg: input.contactTg ?? null,
          address: input.address ?? null,
          notes: input.notes ?? null,
        })
        .returning();
      await auditAdmin(tx, ctx, 'admin.supplier.create', 'supplier', created!.id, input);
      broadcastCatalog(orgId, 'supplier');
      return { id: created!.id };
    });
  }),

  supplierUpdate: authedProcedure.input(SupplierUpdateInputSchema).mutation(async ({ ctx, input }) => {
    requireOrgAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      const existing = await tx.query.suppliers.findFirst({
        where: (sp, { eq: eq2, and: and2 }) =>
          and2(eq2(sp.id, input.supplierId), eq2(sp.orgId, orgId)),
      });
      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.supplierNotFound' });
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (input.name !== undefined) patch.name = input.name;
      if (input.contactPhone !== undefined) patch.contactPhone = input.contactPhone;
      if (input.contactTg !== undefined) patch.contactTg = input.contactTg;
      if (input.address !== undefined) patch.address = input.address;
      if (input.notes !== undefined) patch.notes = input.notes;
      if (input.isArchived !== undefined) patch.isArchived = input.isArchived;
      await tx.update(s.suppliers).set(patch).where(eq(s.suppliers.id, input.supplierId));
      await auditAdmin(tx, ctx, 'admin.supplier.update', 'supplier', input.supplierId, input);
      broadcastCatalog(orgId, 'supplier');
      return { ok: true };
    });
  }),

  supplierDelete: authedProcedure.input(SupplierDeleteInputSchema).mutation(async ({ ctx, input }) => {
    requireOrgAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      const existing = await tx.query.suppliers.findFirst({
        where: (sp, { eq: eq2, and: and2 }) =>
          and2(eq2(sp.id, input.supplierId), eq2(sp.orgId, orgId)),
      });
      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.supplierNotFound' });
      }
      await tx
        .update(s.suppliers)
        .set({ isArchived: true, updatedAt: new Date() })
        .where(eq(s.suppliers.id, input.supplierId));
      await auditAdmin(tx, ctx, 'admin.supplier.delete', 'supplier', input.supplierId, input);
      broadcastCatalog(orgId, 'supplier');
      return { ok: true };
    });
  }),

  // ============ AUDIT (recent domain events) ============

  /** Last N events across the org's order + run streams. Read-only feed
   *  for admins to see what's been happening. */
  recentEvents: authedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const limit = input?.limit ?? 50;
        const rows = await tx
          .select({
            id: s.events.id,
            streamId: s.events.streamId,
            streamType: s.events.streamType,
            seq: s.events.seq,
            type: s.events.type,
            actorId: s.events.actorId,
            occurredAt: s.events.occurredAt,
            payload: s.events.payload,
          })
          .from(s.events)
          .where(eq(s.events.orgId, orgId))
          .orderBy(desc(s.events.occurredAt))
          .limit(limit);
        if (rows.length === 0) return [];
        const userIds = [...new Set(rows.map((r) => r.actorId).filter(Boolean) as string[])];
        const users = userIds.length
          ? await tx
              .select({ id: s.users.id, displayName: s.users.displayName, tgUsername: s.users.tgUsername })
              .from(s.users)
              .where(inArray(s.users.id, userIds))
          : [];
        const userById = new Map(users.map((u) => [u.id, u]));
        return rows.map((r) => ({
          id: r.id,
          streamId: r.streamId,
          streamType: r.streamType,
          seq: r.seq,
          type: r.type,
          actor: r.actorId ? userById.get(r.actorId) ?? null : null,
          occurredAt: r.occurredAt.toISOString(),
          payload: r.payload as unknown,
        }));
      });
    }),

  /**
   * Recent ADMIN actions — distinct from `recentEvents`, which is the
   * order/run domain stream. This pulls from `domain.policy_decisions`
   * (populated by `auditAdmin()` on every catalog/role/permission
   * mutation) so an admin can answer:
   *   - Who renamed this SKU last week?
   *   - Who promoted Ali to manager?
   *   - When did Aziz get the order.approve override?
   *
   * Includes:
   *   - admin.store.* / admin.category.* / admin.sku.* / admin.supplier.*
   *   - admin.role.* (D1)
   *   - admin.memberPermission.* (D2)
   *
   * 50 rows by default; up to 200 for deeper digs.
   */
  adminAuditList: authedProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(200).default(50),
          /** B2 (2026-05-06): filter by store. When set, only rows
           *  whose `scope_store_id` matches are returned. Pre-2026-05-06
           *  rows have NULL scope and are excluded — that's intentional;
           *  the filter answers "what changed in Store X recently". */
          storeId: UuidSchema.optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const limit = input?.limit ?? 50;
        const storeId = input?.storeId;
        const rows = await tx
          .select({
            id: s.policyDecisions.id,
            action: s.policyDecisions.action,
            resourceType: s.policyDecisions.resourceType,
            resourceId: s.policyDecisions.resourceId,
            actorId: s.policyDecisions.actorId,
            occurredAt: s.policyDecisions.occurredAt,
            inputs: s.policyDecisions.inputs,
            scopeStoreId: s.policyDecisions.scopeStoreId,
          })
          .from(s.policyDecisions)
          .where(
            and(
              eq(s.policyDecisions.orgId, orgId),
              ...(storeId ? [eq(s.policyDecisions.scopeStoreId, storeId)] : []),
            ),
          )
          .orderBy(desc(s.policyDecisions.occurredAt))
          .limit(limit);
        if (rows.length === 0) return [];
        const userIds = [...new Set(rows.map((r) => r.actorId).filter(Boolean) as string[])];
        const users = userIds.length
          ? await tx
              .select({
                id: s.users.id,
                displayName: s.users.displayName,
                tgUsername: s.users.tgUsername,
              })
              .from(s.users)
              .where(inArray(s.users.id, userIds))
          : [];
        const userById = new Map(users.map((u) => [u.id, u]));
        return rows.map((r) => ({
          id: r.id,
          action: r.action,
          resourceType: r.resourceType,
          resourceId: r.resourceId,
          actor: r.actorId ? userById.get(r.actorId) ?? null : null,
          occurredAt: r.occurredAt.toISOString(),
          inputs: r.inputs as unknown,
          scopeStoreId: r.scopeStoreId,
        }));
      });
    }),

  // ============ MAINTENANCE / TEST-DATA PURGE ============

  /**
   * Wipe ALL transactional data for the caller's org. Catalog and member
   * rows survive; only what you'd accumulate while testing gets cleared.
   *
   * Tables that have org_id directly — simple WHERE org_id:
   *   ops.notifications, ops.client_logs, inventory.price_history,
   *   read_model.market_runs_v, read_model.order_sessions_v,
   *   domain.events, domain.policy_decisions
   *
   * Tables scoped via FK — must use sub-select against a parent that
   * still has its rows when this delete runs (so order matters):
   *   read_model.run_item_stores_v  (run_id → market_runs_v.id)
   *   read_model.run_items_v        (run_id → market_runs_v.id)
   *   read_model.order_items_v      (session_id → order_sessions_v.id)
   *   sync.outbox                   (event_id → events.id)
   *   domain.snapshots              (stream_id → events.stream_id)
   *
   * Skipped (system-level, not org data):
   *   sync.idempotency_keys, domain.projector_cursors
   */
  purgeAllTestData: authedProcedure
    .input(PurgeAllTestDataInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      // Extra gate: only super_admin can purge.
      if (!ctx.session!.roleSlugs.has('super_admin')) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'admin.errors.purgeRequiresSuperAdmin',
        });
      }
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const org = await tx.query.organizations.findFirst({
          where: (o, { eq: eq2 }) => eq2(o.id, orgId),
        });
        if (!org) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.orgNotFound' });
        }

        // Helper: count rows. Each call is its own SELECT; sequential
        // rather than parallel because we run inside a single tx.
        const counts: Record<string, number> = {};
        const tally = async (label: string, n: number) => {
          counts[label] = n;
        };
        const cnt = async (q: Promise<Array<{ n: number }>>): Promise<number> => {
          const [r] = await q;
          return r?.n ?? 0;
        };

        // Direct org_id counts.
        await tally('domain.events', await cnt(
          tx.select({ n: sql<number>`count(*)::int` })
            .from(s.events).where(eq(s.events.orgId, orgId))
        ));
        await tally('read_model.order_sessions_v', await cnt(
          tx.select({ n: sql<number>`count(*)::int` })
            .from(s.orderSessionsV).where(eq(s.orderSessionsV.orgId, orgId))
        ));
        await tally('read_model.market_runs_v', await cnt(
          tx.select({ n: sql<number>`count(*)::int` })
            .from(s.marketRunsV).where(eq(s.marketRunsV.orgId, orgId))
        ));
        await tally('ops.notifications', await cnt(
          tx.select({ n: sql<number>`count(*)::int` })
            .from(s.notifications).where(eq(s.notifications.orgId, orgId))
        ));
        await tally('ops.client_logs', await cnt(
          tx.select({ n: sql<number>`count(*)::int` })
            .from(s.clientLogs).where(eq(s.clientLogs.orgId, orgId))
        ));
        await tally('inventory.price_history', await cnt(
          tx.select({ n: sql<number>`count(*)::int` })
            .from(s.priceHistory).where(eq(s.priceHistory.orgId, orgId))
        ));
        await tally('domain.policy_decisions', await cnt(
          tx.select({ n: sql<number>`count(*)::int` })
            .from(s.policyDecisions).where(eq(s.policyDecisions.orgId, orgId))
        ));

        // Sub-query counts (FK-scoped).
        await tally('read_model.order_items_v', await cnt(
          tx.execute(
            sql`SELECT count(*)::int AS n FROM read_model.order_items_v
                WHERE session_id IN (
                  SELECT id FROM read_model.order_sessions_v WHERE org_id = ${orgId}
                )`,
          ).then((rows) => rows as unknown as Array<{ n: number }>)
        ));
        await tally('read_model.run_items_v', await cnt(
          tx.execute(
            sql`SELECT count(*)::int AS n FROM read_model.run_items_v
                WHERE run_id IN (
                  SELECT id FROM read_model.market_runs_v WHERE org_id = ${orgId}
                )`,
          ).then((rows) => rows as unknown as Array<{ n: number }>)
        ));
        await tally('read_model.run_item_stores_v', await cnt(
          tx.execute(
            sql`SELECT count(*)::int AS n FROM read_model.run_item_stores_v
                WHERE run_id IN (
                  SELECT id FROM read_model.market_runs_v WHERE org_id = ${orgId}
                )`,
          ).then((rows) => rows as unknown as Array<{ n: number }>)
        ));
        await tally('sync.outbox', await cnt(
          tx.execute(
            sql`SELECT count(*)::int AS n FROM sync.outbox
                WHERE event_id IN (
                  SELECT id FROM domain.events WHERE org_id = ${orgId}
                )`,
          ).then((rows) => rows as unknown as Array<{ n: number }>)
        ));
        await tally('domain.snapshots', await cnt(
          tx.execute(
            sql`SELECT count(*)::int AS n FROM domain.snapshots
                WHERE stream_id IN (
                  SELECT DISTINCT stream_id FROM domain.events WHERE org_id = ${orgId}
                )`,
          ).then((rows) => rows as unknown as Array<{ n: number }>)
        ));

        const total = Object.values(counts).reduce((a, b) => a + b, 0);

        if (input.dryRun) {
          return { dryRun: true, total, byTable: counts, orgSlug: org.slug };
        }

        // Destructive path requires confirmText match.
        if (input.confirmText !== org.slug) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'admin.errors.purgeConfirmMismatch',
          });
        }

        // Order: dependents first, then parents.
        await tx.execute(
          sql`DELETE FROM read_model.run_item_stores_v
              WHERE run_id IN (SELECT id FROM read_model.market_runs_v WHERE org_id = ${orgId})`,
        );
        await tx.execute(
          sql`DELETE FROM read_model.run_items_v
              WHERE run_id IN (SELECT id FROM read_model.market_runs_v WHERE org_id = ${orgId})`,
        );
        await tx.delete(s.marketRunsV).where(eq(s.marketRunsV.orgId, orgId));

        await tx.execute(
          sql`DELETE FROM read_model.order_items_v
              WHERE session_id IN (SELECT id FROM read_model.order_sessions_v WHERE org_id = ${orgId})`,
        );
        await tx.delete(s.orderSessionsV).where(eq(s.orderSessionsV.orgId, orgId));

        await tx.execute(
          sql`DELETE FROM sync.outbox
              WHERE event_id IN (SELECT id FROM domain.events WHERE org_id = ${orgId})`,
        );
        await tx.execute(
          sql`DELETE FROM domain.snapshots
              WHERE stream_id IN (SELECT DISTINCT stream_id FROM domain.events WHERE org_id = ${orgId})`,
        );
        await tx.delete(s.events).where(eq(s.events.orgId, orgId));

        await tx.delete(s.priceHistory).where(eq(s.priceHistory.orgId, orgId));
        await tx.delete(s.notifications).where(eq(s.notifications.orgId, orgId));
        await tx.delete(s.clientLogs).where(eq(s.clientLogs.orgId, orgId));
        await tx.delete(s.policyDecisions).where(eq(s.policyDecisions.orgId, orgId));

        return { dryRun: false, total, byTable: counts, orgSlug: org.slug };
      });
    }),

  /**
   * Wipe one day's full order → run → delivery flow for this org.
   *
   * Cascade strategy:
   *   1. Sessions whose orderDate = $date → events with those streamIds.
   *   2. Runs whose runDate    = $date → events with those streamIds.
   *   3. Run-item-stores + run-items belonging to those runs.
   *   4. Order-items belonging to those sessions.
   *   5. Snapshots for those streamIds.
   *   6. Outbox rows whose eventId is in the doomed event set.
   *   7. Notifications with payload.sessionId / payload.runId in the
   *      doomed sets — uses JSONB ->> for the lookup.
   *   8. Price history rows with the same runId set.
   *
   * Two passes: first pass is read-only and counts rows for the dry-run
   * preview; second pass actually deletes. Wrapped in a single tx, so a
   * partial failure rolls back the whole thing.
   */
  purgeByDate: authedProcedure
    .input(PurgeByDateInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      if (!ctx.session!.roleSlugs.has('super_admin')) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'admin.errors.purgeRequiresSuperAdmin',
        });
      }
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const date = input.date;

        // Resolve the affected stream id sets up-front. We use these
        // in both the count and the delete passes so the numbers are
        // self-consistent (no race between count and delete inside
        // the same tx).
        const sessionIdsResult = await tx.execute(
          sql`SELECT id FROM read_model.order_sessions_v
              WHERE org_id = ${orgId} AND order_date = ${date}`,
        );
        const sessionIds: string[] = (sessionIdsResult as unknown as Array<{ id: string }>).map(
          (r) => r.id,
        );

        const runIdsResult = await tx.execute(
          sql`SELECT id FROM read_model.market_runs_v
              WHERE org_id = ${orgId} AND run_date = ${date}`,
        );
        const runIds: string[] = (runIdsResult as unknown as Array<{ id: string }>).map(
          (r) => r.id,
        );

        const allStreamIds = [...sessionIds, ...runIds];

        const counts: Record<string, number> = {
          'read_model.order_sessions_v': 0,
          'read_model.order_items_v': 0,
          'read_model.market_runs_v': 0,
          'read_model.run_items_v': 0,
          'read_model.run_item_stores_v': 0,
          'domain.events': 0,
          'domain.snapshots': 0,
          'sync.outbox': 0,
          'ops.notifications': 0,
          'inventory.price_history': 0,
        };

        // Counts.
        counts['read_model.order_sessions_v'] = sessionIds.length;
        counts['read_model.market_runs_v'] = runIds.length;

        if (sessionIds.length > 0) {
          const r = await tx.execute(
            sql`SELECT count(*)::int AS n FROM read_model.order_items_v
                WHERE session_id IN ${sql.raw(`(${sessionIds.map((id) => `'${id}'`).join(',')})`)}`,
          );
          counts['read_model.order_items_v'] = (r as unknown as Array<{ n: number }>)[0]?.n ?? 0;
        }
        if (runIds.length > 0) {
          const r1 = await tx.execute(
            sql`SELECT count(*)::int AS n FROM read_model.run_items_v
                WHERE run_id IN ${sql.raw(`(${runIds.map((id) => `'${id}'`).join(',')})`)}`,
          );
          counts['read_model.run_items_v'] = (r1 as unknown as Array<{ n: number }>)[0]?.n ?? 0;
          const r2 = await tx.execute(
            sql`SELECT count(*)::int AS n FROM read_model.run_item_stores_v
                WHERE run_id IN ${sql.raw(`(${runIds.map((id) => `'${id}'`).join(',')})`)}`,
          );
          counts['read_model.run_item_stores_v'] = (r2 as unknown as Array<{ n: number }>)[0]?.n ?? 0;
          const r3 = await tx.execute(
            sql`SELECT count(*)::int AS n FROM inventory.price_history
                WHERE org_id = ${orgId}
                  AND run_id IN ${sql.raw(`(${runIds.map((id) => `'${id}'`).join(',')})`)}`,
          );
          counts['inventory.price_history'] = (r3 as unknown as Array<{ n: number }>)[0]?.n ?? 0;
        }
        if (allStreamIds.length > 0) {
          const r1 = await tx.execute(
            sql`SELECT count(*)::int AS n FROM domain.events
                WHERE org_id = ${orgId}
                  AND stream_id IN ${sql.raw(`(${allStreamIds.map((id) => `'${id}'`).join(',')})`)}`,
          );
          counts['domain.events'] = (r1 as unknown as Array<{ n: number }>)[0]?.n ?? 0;
          const r2 = await tx.execute(
            sql`SELECT count(*)::int AS n FROM domain.snapshots
                WHERE stream_id IN ${sql.raw(`(${allStreamIds.map((id) => `'${id}'`).join(',')})`)}`,
          );
          counts['domain.snapshots'] = (r2 as unknown as Array<{ n: number }>)[0]?.n ?? 0;
          const r3 = await tx.execute(
            sql`SELECT count(*)::int AS n FROM sync.outbox
                WHERE event_id IN (
                  SELECT id FROM domain.events
                  WHERE org_id = ${orgId}
                    AND stream_id IN ${sql.raw(`(${allStreamIds.map((id) => `'${id}'`).join(',')})`)}
                )`,
          );
          counts['sync.outbox'] = (r3 as unknown as Array<{ n: number }>)[0]?.n ?? 0;
          // Notifications stash sessionId/runId in payload jsonb.
          const r4 = await tx.execute(
            sql`SELECT count(*)::int AS n FROM ops.notifications
                WHERE org_id = ${orgId}
                  AND (
                    payload->>'sessionId' IN ${sql.raw(`(${allStreamIds.map((id) => `'${id}'`).join(',')})`)}
                    OR payload->>'runId' IN ${sql.raw(`(${allStreamIds.map((id) => `'${id}'`).join(',')})`)}
                  )`,
          );
          counts['ops.notifications'] = (r4 as unknown as Array<{ n: number }>)[0]?.n ?? 0;
        }

        const total = Object.values(counts).reduce((a, b) => a + b, 0);

        if (input.dryRun) {
          return { dryRun: true, total, byTable: counts, date };
        }

        // Commit pass — same id sets, dependency-safe order.
        if (runIds.length > 0) {
          const inRuns = sql.raw(`(${runIds.map((id) => `'${id}'`).join(',')})`);
          await tx.execute(
            sql`DELETE FROM read_model.run_item_stores_v WHERE run_id IN ${inRuns}`,
          );
          await tx.execute(
            sql`DELETE FROM read_model.run_items_v WHERE run_id IN ${inRuns}`,
          );
          await tx.execute(
            sql`DELETE FROM inventory.price_history
                WHERE org_id = ${orgId} AND run_id IN ${inRuns}`,
          );
          await tx.execute(
            sql`DELETE FROM read_model.market_runs_v
                WHERE org_id = ${orgId} AND id IN ${inRuns}`,
          );
        }
        if (sessionIds.length > 0) {
          const inSessions = sql.raw(`(${sessionIds.map((id) => `'${id}'`).join(',')})`);
          await tx.execute(
            sql`DELETE FROM read_model.order_items_v WHERE session_id IN ${inSessions}`,
          );
          await tx.execute(
            sql`DELETE FROM read_model.order_sessions_v
                WHERE org_id = ${orgId} AND id IN ${inSessions}`,
          );
        }
        if (allStreamIds.length > 0) {
          const inStreams = sql.raw(`(${allStreamIds.map((id) => `'${id}'`).join(',')})`);
          // Notifications first (cheap; doesn't depend on events).
          await tx.execute(
            sql`DELETE FROM ops.notifications
                WHERE org_id = ${orgId}
                  AND (
                    payload->>'sessionId' IN ${inStreams}
                    OR payload->>'runId' IN ${inStreams}
                  )`,
          );
          // Outbox before events (event_id FK).
          await tx.execute(
            sql`DELETE FROM sync.outbox
                WHERE event_id IN (
                  SELECT id FROM domain.events
                  WHERE org_id = ${orgId} AND stream_id IN ${inStreams}
                )`,
          );
          await tx.execute(
            sql`DELETE FROM domain.snapshots WHERE stream_id IN ${inStreams}`,
          );
          await tx.execute(
            sql`DELETE FROM domain.events
                WHERE org_id = ${orgId} AND stream_id IN ${inStreams}`,
          );
        }

        return { dryRun: false, total, byTable: counts, date };
      });
    }),

  // ============ TARGETED PURGE: list + per-session + per-run ============

  /**
   * List recent order sessions the admin can choose to delete. Powers
   * the "pick one to nuke" UI in Maintenance. Includes ALL statuses so
   * an admin can purge in_run / archived sessions via the run path.
   */
  sessionList: authedProcedure
    .input(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }).optional(),
    )
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const date = input?.date;
        const limit = input?.limit ?? 50;
        const rows = await tx
          .select({
            id: s.orderSessionsV.id,
            storeId: s.orderSessionsV.storeId,
            initiatedByMemberId: s.orderSessionsV.initiatedByMemberId,
            submittedByMemberId: s.orderSessionsV.submittedByMemberId,
            orderDate: s.orderSessionsV.orderDate,
            status: s.orderSessionsV.status,
            runId: s.orderSessionsV.runId,
            updatedAt: s.orderSessionsV.updatedAt,
          })
          .from(s.orderSessionsV)
          .where(
            date
              ? and(
                  eq(s.orderSessionsV.orgId, orgId),
                  eq(s.orderSessionsV.orderDate, date),
                )
              : eq(s.orderSessionsV.orgId, orgId),
          )
          .orderBy(desc(s.orderSessionsV.updatedAt))
          .limit(limit);
        if (rows.length === 0) return [];
        const storeIds = [...new Set(rows.map((r) => r.storeId))];
        // Attribution: prefer submitter, fall back to initiator.
        const memberIds = [
          ...new Set(
            rows
              .map((r) => r.submittedByMemberId ?? r.initiatedByMemberId)
              .filter(Boolean) as string[],
          ),
        ];
        const [stores, memberJoins, contributors] = await Promise.all([
          tx.query.stores.findMany({
            where: (st, { inArray: ia }) => ia(st.id, storeIds),
          }),
          memberIds.length
            ? tx
                .select({
                  memberId: s.members.id,
                  userId: s.members.userId,
                  displayName: s.users.displayName,
                  tgUsername: s.users.tgUsername,
                })
                .from(s.members)
                .innerJoin(s.users, eq(s.users.id, s.members.userId))
                .where(inArray(s.members.id, memberIds))
            : Promise.resolve([] as Array<{ memberId: string; userId: string; displayName: string; tgUsername: string | null }>),
          // All raw rows for these sessions (we'll filter empty ones out).
          tx
            .select({
              sessionId: s.orderItemsV.sessionId,
              skuId: s.orderItemsV.skuId,
              contributorMemberId: s.orderItemsV.contributorMemberId,
              qty: s.orderItemsV.qty,
            })
            .from(s.orderItemsV)
            .where(inArray(s.orderItemsV.sessionId, rows.map((r) => r.id))),
        ]);
        const storeById = new Map(stores.map((st) => [st.id, st]));
        const memberById = new Map(memberJoins.map((m) => [m.memberId, m]));
        const callerMemberRow = await tx.query.members.findFirst({
          where: (m, { eq: eq2, and: and2 }) =>
            and2(eq2(m.orgId, orgId), eq2(m.userId, ctx.session!.userId)),
        });
        const callerMemberId = callerMemberRow?.id ?? null;

        // Per-session: aggregate qty across contributors per SKU.
        const skuTotalsBySession = new Map<string, Map<string, number>>();
        const sessionsWhereImAuthor = new Set<string>();
        for (const c of contributors) {
          const v = Number(c.qty);
          const m = skuTotalsBySession.get(c.sessionId) ?? new Map<string, number>();
          if (v > 0) {
            m.set(c.skuId, (m.get(c.skuId) ?? 0) + v);
            if (c.contributorMemberId === callerMemberId) {
              sessionsWhereImAuthor.add(c.sessionId);
            }
          }
          skuTotalsBySession.set(c.sessionId, m);
        }
        const aggregateBySession = new Map<string, { itemCount: number; totalQty: number }>();
        for (const [sessionId, skuTotals] of skuTotalsBySession) {
          let count = 0;
          let total = 0;
          for (const v of skuTotals.values()) {
            if (v > 0) {
              count += 1;
              total += v;
            }
          }
          aggregateBySession.set(sessionId, { itemCount: count, totalQty: total });
        }

        return rows
          .map((r) => {
            const attribMemberId = r.submittedByMemberId ?? r.initiatedByMemberId;
            const m = attribMemberId ? memberById.get(attribMemberId) : null;
            const agg = aggregateBySession.get(r.id) ?? { itemCount: 0, totalQty: 0 };
            return {
              sessionId: r.id,
              storeId: r.storeId,
              storeName: storeById.get(r.storeId)?.name ?? null,
              attribMemberId: attribMemberId ?? null,
              attribDisplayName: m?.displayName ?? null,
              attribTgUsername: m?.tgUsername ?? null,
              isMine:
                sessionsWhereImAuthor.has(r.id) ||
                (attribMemberId !== null && attribMemberId === callerMemberId),
              orderDate: r.orderDate,
              status: r.status,
              runId: r.runId,
              itemCount: agg.itemCount,
              totalQty: agg.totalQty.toFixed(3).replace(/\.?0+$/, ''),
              updatedAt: r.updatedAt.toISOString(),
            };
          })
          // #4: an "empty" session (every contributor's qty is 0) shouldn't
          // clutter the maintenance browser. Only show sessions that have
          // at least one SKU with non-zero aggregate qty, OR whose status
          // moved past draft (e.g. submitted-and-then-everything-cleared
          // is still meaningful for audit).
          .filter((r) => r.itemCount > 0 || r.status !== 'draft');
      });
    }),

  /**
   * List recent market runs the admin can choose to delete.
   */
  runList: authedProcedure
    .input(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }).optional(),
    )
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const date = input?.date;
        const limit = input?.limit ?? 50;
        const rows = await tx
          .select({
            id: s.marketRunsV.id,
            runDate: s.marketRunsV.runDate,
            runIndex: s.marketRunsV.runIndex,
            status: s.marketRunsV.status,
            purchaserMemberId: s.marketRunsV.purchaserMemberId,
            sessionIdsJson: s.marketRunsV.sessionIdsJson,
            updatedAt: s.marketRunsV.updatedAt,
          })
          .from(s.marketRunsV)
          .where(
            date
              ? and(
                  eq(s.marketRunsV.orgId, orgId),
                  eq(s.marketRunsV.runDate, date),
                )
              : eq(s.marketRunsV.orgId, orgId),
          )
          .orderBy(desc(s.marketRunsV.updatedAt))
          .limit(limit);
        if (rows.length === 0) return [];
        const memberIds = [
          ...new Set(rows.map((r) => r.purchaserMemberId).filter(Boolean) as string[]),
        ];
        const memberJoins = memberIds.length
          ? await tx
              .select({
                memberId: s.members.id,
                userId: s.members.userId,
                displayName: s.users.displayName,
              })
              .from(s.members)
              .innerJoin(s.users, eq(s.users.id, s.members.userId))
              .where(inArray(s.members.id, memberIds))
          : [];
        const memberById = new Map(memberJoins.map((m) => [m.memberId, m]));
        return rows.map((r) => {
          const sessionIds = (r.sessionIdsJson as unknown as string[]) ?? [];
          const m = r.purchaserMemberId ? memberById.get(r.purchaserMemberId) : null;
          return {
            runId: r.id,
            runDate: r.runDate,
            runIndex: r.runIndex,
            status: r.status,
            sessionCount: sessionIds.length,
            purchaserDisplayName: m?.displayName ?? null,
            purchaserIsMe: m?.userId === ctx.session!.userId,
            updatedAt: r.updatedAt.toISOString(),
          };
        });
      });
    }),

  /**
   * Submission history feed: per-store timeline of every order that has
   * been submitted, with status outcome + approval delay + per-SKU
   * totals + per-contributor breakdown. Read-only — pure audit/insight
   * surface for managers and admins. Filtered to the caller's org via
   * RLS; the date range defaults to the last 30 days.
   */
  submissionHistory: authedProcedure
    .input(
      z
        .object({
          storeId: UuidSchema.optional(),
          fromDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          toDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const limit = input?.limit ?? 50;
        // D.1 (M3.39, 2026-05-20): default date range is "today and the
        // previous 30 days", both expressed in the ORG's timezone. The
        // previous UTC-based default could put `toDate` one day behind
        // the user's local calendar for any UZ-tenant request between
        // 00:00 and 05:00 UTC.
        const tz = ctx.session!.orgTimezone;
        const sevenDaysOrFrom =
          input?.fromDate ??
          dateInTz(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), tz);
        const toDate = input?.toDate ?? todayInTz(tz);

        // Only sessions that progressed past draft are "submissions".
        // We use a raw query so we can express the date range + status
        // filter cleanly without drizzle hoops.
        const rawSessions = (await tx.execute(
          sql`SELECT id, store_id, order_date, status, submitted_at, decided_at,
                     submitted_by_member_id, decided_by_member_id, reject_reason, run_id
              FROM read_model.order_sessions_v
              WHERE org_id = ${orgId}
                AND status IN ('submitted','approved','rejected','in_run','archived')
                AND order_date >= ${sevenDaysOrFrom}
                AND order_date <= ${toDate}
                ${input?.storeId ? sql`AND store_id = ${input.storeId}` : sql``}
              ORDER BY submitted_at DESC NULLS LAST
              LIMIT ${limit}`,
        )) as unknown as Array<{
          id: string;
          store_id: string;
          order_date: string;
          status: string;
          submitted_at: Date | null;
          decided_at: Date | null;
          submitted_by_member_id: string | null;
          decided_by_member_id: string | null;
          reject_reason: string | null;
          run_id: string | null;
        }>;
        if (rawSessions.length === 0) return [];

        const sessionIds = rawSessions.map((r) => r.id);
        const storeIds = [...new Set(rawSessions.map((r) => r.store_id))];
        const memberIds = [
          ...new Set(
            [
              ...rawSessions.map((r) => r.submitted_by_member_id),
              ...rawSessions.map((r) => r.decided_by_member_id),
            ].filter(Boolean) as string[],
          ),
        ];

        const [items, stores, members] = await Promise.all([
          tx.query.orderItemsV.findMany({
            where: (it, { inArray: ia }) => ia(it.sessionId, sessionIds),
          }),
          tx.query.stores.findMany({
            where: (st, { inArray: ia }) => ia(st.id, storeIds),
          }),
          memberIds.length
            ? tx
                .select({
                  memberId: s.members.id,
                  displayName: s.users.displayName,
                })
                .from(s.members)
                .innerJoin(s.users, eq(s.users.id, s.members.userId))
                .where(inArray(s.members.id, memberIds))
            : Promise.resolve([] as Array<{ memberId: string; displayName: string }>),
        ]);
        const storeById = new Map(stores.map((st) => [st.id, st]));
        const memberById = new Map(members.map((m) => [m.memberId, m.displayName]));

        // Per-session: contributor → SKUs[] → qty.
        const skuTotalsBySession = new Map<string, Map<string, number>>();
        const contributorsBySession = new Map<
          string,
          Map<string, Array<{ skuId: string; qty: number }>>
        >();
        for (const it of items) {
          const v = Number(it.qty);
          if (v <= 0) continue;
          const tot = skuTotalsBySession.get(it.sessionId) ?? new Map<string, number>();
          tot.set(it.skuId, (tot.get(it.skuId) ?? 0) + v);
          skuTotalsBySession.set(it.sessionId, tot);
          const cmap = contributorsBySession.get(it.sessionId) ?? new Map();
          const arr = cmap.get(it.contributorMemberId) ?? [];
          arr.push({ skuId: it.skuId, qty: v });
          cmap.set(it.contributorMemberId, arr);
          contributorsBySession.set(it.sessionId, cmap);
        }

        return rawSessions.map((sess) => {
          const totals = skuTotalsBySession.get(sess.id) ?? new Map();
          const contribs = contributorsBySession.get(sess.id) ?? new Map();
          const submittedAt = sess.submitted_at ? new Date(sess.submitted_at) : null;
          const decidedAt = sess.decided_at ? new Date(sess.decided_at) : null;
          const reviewMinutes =
            submittedAt && decidedAt
              ? Math.round((decidedAt.getTime() - submittedAt.getTime()) / 60000)
              : null;
          return {
            sessionId: sess.id,
            storeId: sess.store_id,
            storeName: storeById.get(sess.store_id)?.name ?? null,
            orderDate: sess.order_date,
            status: sess.status,
            submittedAt: submittedAt?.toISOString() ?? null,
            submittedByMemberId: sess.submitted_by_member_id,
            submittedByName: sess.submitted_by_member_id
              ? memberById.get(sess.submitted_by_member_id) ?? null
              : null,
            decidedAt: decidedAt?.toISOString() ?? null,
            decidedByMemberId: sess.decided_by_member_id,
            decidedByName: sess.decided_by_member_id
              ? memberById.get(sess.decided_by_member_id) ?? null
              : null,
            rejectReason: sess.reject_reason,
            runId: sess.run_id,
            reviewMinutes,
            skuCount: totals.size,
            totalQty: [...totals.values()].reduce((a, b) => a + b, 0),
            contributors: [...contribs.entries()].map(([memberId, lines]) => ({
              memberId,
              displayName: memberById.get(memberId) ?? null,
              skuCount: lines.length,
              totalQty: (lines as Array<{ skuId: string; qty: number }>).reduce(
                (s2, l) => s2 + l.qty,
                0,
              ),
            })),
          };
        });
      });
    }),

  /** Surgical single-session purge. See PurgeSessionInputSchema doc. */
  purgeSession: authedProcedure
    .input(PurgeSessionInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      if (!ctx.session!.roleSlugs.has('super_admin')) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'admin.errors.purgeRequiresSuperAdmin',
        });
      }
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const session = await tx.query.orderSessionsV.findFirst({
          where: (sess, { eq: eq2, and: and2 }) =>
            and2(eq2(sess.id, input.sessionId), eq2(sess.orgId, orgId)),
        });
        if (!session) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.sessionNotFound' });
        }
        // Refuse if attached to a run — caller should purge the run.
        if (session.status === 'in_run' || session.status === 'archived' || session.runId) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'admin.errors.sessionAttachedToRun',
          });
        }

        const counts = await countSessionCascade(tx, orgId, input.sessionId);
        if (input.dryRun) {
          return {
            dryRun: true,
            total: Object.values(counts).reduce((a, b) => a + b, 0),
            byTable: counts,
            sessionId: input.sessionId,
          };
        }
        await deleteSessionCascade(tx, orgId, input.sessionId);
        return {
          dryRun: false,
          total: Object.values(counts).reduce((a, b) => a + b, 0),
          byTable: counts,
          sessionId: input.sessionId,
        };
      });
    }),

  /** Whole-run purge. See PurgeRunInputSchema doc. */
  purgeRun: authedProcedure
    .input(PurgeRunInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      if (!ctx.session!.roleSlugs.has('super_admin')) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'admin.errors.purgeRequiresSuperAdmin',
        });
      }
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const run = await tx.query.marketRunsV.findFirst({
          where: (r, { eq: eq2, and: and2 }) =>
            and2(eq2(r.id, input.runId), eq2(r.orgId, orgId)),
        });
        if (!run) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.runNotFound' });
        }
        const sessionIds = (run.sessionIdsJson as unknown as string[]) ?? [];

        // Safety: refuse if any attached session belongs to someone other
        // than the caller, unless explicitly waived.
        if (input.requireOnlyTestSessions && sessionIds.length > 0) {
          // Per-store sessions can have multiple contributors. A session
          // counts as "test" only if every line author AND the submitter
          // is the caller. Anyone else's line → refuse.
          const myMember = await tx.query.members.findFirst({
            where: (m, { eq: eq2, and: and2 }) =>
              and2(eq2(m.orgId, orgId), eq2(m.userId, ctx.session!.userId)),
          });
          const myMemberId = myMember?.id ?? null;
          const sessions = await tx.query.orderSessionsV.findMany({
            where: (sess, { inArray: ia }) => ia(sess.id, sessionIds),
          });
          const items = await tx.query.orderItemsV.findMany({
            where: (it, { inArray: ia }) => ia(it.sessionId, sessionIds),
          });
          const foreignAttribs = new Set<string>();
          for (const sess of sessions) {
            if (sess.submittedByMemberId && sess.submittedByMemberId !== myMemberId) {
              foreignAttribs.add(sess.submittedByMemberId);
            }
            if (
              sess.initiatedByMemberId &&
              sess.initiatedByMemberId !== myMemberId &&
              !sess.submittedByMemberId
            ) {
              foreignAttribs.add(sess.initiatedByMemberId);
            }
          }
          for (const it of items) {
            if (it.contributorMemberId && it.contributorMemberId !== myMemberId) {
              foreignAttribs.add(it.contributorMemberId);
            }
          }
          if (foreignAttribs.size > 0) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'admin.errors.runHasForeignSessions',
            });
          }
        }

        const counts = await countRunCascade(tx, orgId, input.runId, sessionIds);
        if (input.dryRun) {
          return {
            dryRun: true,
            total: Object.values(counts).reduce((a, b) => a + b, 0),
            byTable: counts,
            runId: input.runId,
            sessionIds,
          };
        }
        await deleteRunCascade(tx, orgId, input.runId, sessionIds);
        return {
          dryRun: false,
          total: Object.values(counts).reduce((a, b) => a + b, 0),
          byTable: counts,
          runId: input.runId,
          sessionIds,
        };
      });
    }),
});

// ---------- session/run cascade helpers ----------
// Drizzle's transactional type is annoying to import here; the helpers
// only call `.execute(sql\`...\`)` so a structural type is enough.
type Tx = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };

async function countSessionCascade(
  tx: Tx,
  orgId: string,
  sessionId: string,
): Promise<Record<string, number>> {
  const sId = sessionId;
  const c: Record<string, number> = {};
  const exec = async (label: string, q: ReturnType<typeof sql>) => {
    const rows = (await tx.execute(q)) as unknown as Array<{ n: number }>;
    c[label] = rows[0]?.n ?? 0;
  };
  c['read_model.order_sessions_v'] = 1;
  await exec(
    'read_model.order_items_v',
    sql`SELECT count(*)::int AS n FROM read_model.order_items_v WHERE session_id = ${sId}`,
  );
  await exec(
    'domain.events',
    sql`SELECT count(*)::int AS n FROM domain.events WHERE org_id = ${orgId} AND stream_id = ${sId}`,
  );
  await exec(
    'domain.snapshots',
    sql`SELECT count(*)::int AS n FROM domain.snapshots WHERE stream_id = ${sId}`,
  );
  await exec(
    'sync.outbox',
    sql`SELECT count(*)::int AS n FROM sync.outbox
        WHERE event_id IN (SELECT id FROM domain.events WHERE org_id = ${orgId} AND stream_id = ${sId})`,
  );
  await exec(
    'ops.notifications',
    sql`SELECT count(*)::int AS n FROM ops.notifications
        WHERE org_id = ${orgId} AND payload->>'sessionId' = ${sId}`,
  );
  return c;
}

async function deleteSessionCascade(tx: Tx, orgId: string, sessionId: string): Promise<void> {
  const sId = sessionId;
  // Notifications first (no FK).
  await tx.execute(
    sql`DELETE FROM ops.notifications
        WHERE org_id = ${orgId} AND payload->>'sessionId' = ${sId}`,
  );
  // Outbox before events (event_id FK).
  await tx.execute(
    sql`DELETE FROM sync.outbox
        WHERE event_id IN (SELECT id FROM domain.events WHERE org_id = ${orgId} AND stream_id = ${sId})`,
  );
  await tx.execute(
    sql`DELETE FROM domain.snapshots WHERE stream_id = ${sId}`,
  );
  await tx.execute(
    sql`DELETE FROM domain.events WHERE org_id = ${orgId} AND stream_id = ${sId}`,
  );
  await tx.execute(
    sql`DELETE FROM read_model.order_items_v WHERE session_id = ${sId}`,
  );
  await tx.execute(
    sql`DELETE FROM read_model.order_sessions_v WHERE org_id = ${orgId} AND id = ${sId}`,
  );
}

async function countRunCascade(
  tx: Tx,
  orgId: string,
  runId: string,
  sessionIds: string[],
): Promise<Record<string, number>> {
  const c: Record<string, number> = {};
  const exec = async (label: string, q: ReturnType<typeof sql>) => {
    const rows = (await tx.execute(q)) as unknown as Array<{ n: number }>;
    c[label] = rows[0]?.n ?? 0;
  };
  c['read_model.market_runs_v'] = 1;
  c['read_model.order_sessions_v'] = sessionIds.length;
  await exec(
    'read_model.run_items_v',
    sql`SELECT count(*)::int AS n FROM read_model.run_items_v WHERE run_id = ${runId}`,
  );
  await exec(
    'read_model.run_item_stores_v',
    sql`SELECT count(*)::int AS n FROM read_model.run_item_stores_v WHERE run_id = ${runId}`,
  );
  await exec(
    'inventory.price_history',
    sql`SELECT count(*)::int AS n FROM inventory.price_history WHERE org_id = ${orgId} AND run_id = ${runId}`,
  );
  // All streams = run + all attached sessions.
  const allStreams = [runId, ...sessionIds];
  if (allStreams.length > 0) {
    const inStreams = sql.raw(`(${allStreams.map((id) => `'${id}'`).join(',')})`);
    await exec(
      'domain.events',
      sql`SELECT count(*)::int AS n FROM domain.events WHERE org_id = ${orgId} AND stream_id IN ${inStreams}`,
    );
    await exec(
      'domain.snapshots',
      sql`SELECT count(*)::int AS n FROM domain.snapshots WHERE stream_id IN ${inStreams}`,
    );
    await exec(
      'sync.outbox',
      sql`SELECT count(*)::int AS n FROM sync.outbox
          WHERE event_id IN (
            SELECT id FROM domain.events WHERE org_id = ${orgId} AND stream_id IN ${inStreams}
          )`,
    );
    await exec(
      'ops.notifications',
      sql`SELECT count(*)::int AS n FROM ops.notifications
          WHERE org_id = ${orgId}
            AND (payload->>'sessionId' IN ${inStreams} OR payload->>'runId' IN ${inStreams})`,
    );
    await exec(
      'read_model.order_items_v',
      sql`SELECT count(*)::int AS n FROM read_model.order_items_v
          WHERE session_id IN ${sessionIds.length > 0 ? sql.raw(`(${sessionIds.map((id) => `'${id}'`).join(',')})`) : sql.raw(`('00000000-0000-0000-0000-000000000000')`)}`,
    );
  }
  return c;
}

async function deleteRunCascade(
  tx: Tx,
  orgId: string,
  runId: string,
  sessionIds: string[],
): Promise<void> {
  const allStreams = [runId, ...sessionIds];
  // Notifications first.
  if (allStreams.length > 0) {
    const inStreams = sql.raw(`(${allStreams.map((id) => `'${id}'`).join(',')})`);
    await tx.execute(
      sql`DELETE FROM ops.notifications
          WHERE org_id = ${orgId}
            AND (payload->>'sessionId' IN ${inStreams} OR payload->>'runId' IN ${inStreams})`,
    );
    await tx.execute(
      sql`DELETE FROM sync.outbox
          WHERE event_id IN (
            SELECT id FROM domain.events WHERE org_id = ${orgId} AND stream_id IN ${inStreams}
          )`,
    );
    await tx.execute(
      sql`DELETE FROM domain.snapshots WHERE stream_id IN ${inStreams}`,
    );
    await tx.execute(
      sql`DELETE FROM domain.events WHERE org_id = ${orgId} AND stream_id IN ${inStreams}`,
    );
  }
  // Run-side projections.
  await tx.execute(
    sql`DELETE FROM read_model.run_item_stores_v WHERE run_id = ${runId}`,
  );
  await tx.execute(
    sql`DELETE FROM read_model.run_items_v WHERE run_id = ${runId}`,
  );
  await tx.execute(
    sql`DELETE FROM inventory.price_history WHERE org_id = ${orgId} AND run_id = ${runId}`,
  );
  await tx.execute(
    sql`DELETE FROM read_model.market_runs_v WHERE org_id = ${orgId} AND id = ${runId}`,
  );
  // Session-side projections (attached sessions).
  if (sessionIds.length > 0) {
    const inSessions = sql.raw(`(${sessionIds.map((id) => `'${id}'`).join(',')})`);
    await tx.execute(
      sql`DELETE FROM read_model.order_items_v WHERE session_id IN ${inSessions}`,
    );
    await tx.execute(
      sql`DELETE FROM read_model.order_sessions_v WHERE org_id = ${orgId} AND id IN ${inSessions}`,
    );
  }
}

