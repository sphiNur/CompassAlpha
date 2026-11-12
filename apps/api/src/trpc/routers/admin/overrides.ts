/** Per-member permission overrides: one key allowed or denied for one member. */
import { TRPCError } from '@trpc/server';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s } from '@compass/db';
import { ADMIN_RANK, ORG_WIDE_PERMISSION_KEYS, UuidSchema } from '@compass/contracts';
import { authedProcedure } from '../../trpc';
import { hasGlobalPermission } from '../../../services/orgAdmin';
import {
  effectivePermissionsForStore,
  flatEffectivePermissions,
  loadScopedPermissions,
  permissionsByScope,
} from '../../../services/storeScope';
import {
  getActorMaxGlobalRank,
  getActorMaxRank,
  getActorMaxRankInStore,
} from '../../../services/adminAuthority';
import { requireAdmin, requireOrgAdmin } from './guards';
import { broadcastPeople } from './notify';
import { getActorAdminStoreIds, getAdminReadScope, visibleMemberIds } from './scope';
import { exemptFromKeyCheck } from './grants';
import { auditAdmin } from '../../../services/adminAudit';

export const overrideProcedures = {
  // ============ MEMBER PERMISSION OVERRIDES (added 2026-05-05) ============
  //
  // These let an admin tweak a single member's permissions without
  // creating a whole new role. Two staff with the same role can end
  // up with different effective permissions via 'allow' / 'deny'
  // overrides. See `auth.member_permission_overrides` schema.

  /**
   * Read the role-derived baseline + the override layer for one member.
   * Returns:
   *   byScope      — per scope (ADM1-05): `global`, and each store a
   *                  binding or override names (`stores[id]`; any other
   *                  store is as `global`), its role keys and its
   *                  effective keys after overrides
   *   overrides    — explicit per-member rows (allow + deny + scope)
   *   roleKeys     — union of the member's role permissions
   *   effective    — keys effective in some scope (the session's set)
   *
   * UI shows the tab's role keys as a grayed-out "from role" badge and
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
        // 2026-10-21 CA-17: outside org admins, only members of stores
        // the actor administers; grants tied to other stores are hidden.
        const scope = await getAdminReadScope(tx, ctx.session!);
        const isSelf = member.id === ctx.session!.memberId;
        if (scope && !isSelf) {
          const visible = await visibleMemberIds(tx, scope, ctx.session!.memberId);
          if (!visible.has(member.id)) {
            throw new TRPCError({ code: 'FORBIDDEN', message: 'admin.errors.notAdminOfStore' });
          }
        }
        const scopeVisible = (scopeType: string, scopeId: string | null) =>
          !scope || isSelf || scopeType !== 'store' || (!!scopeId && scope.has(scopeId));
        // Role-derived keys, each with the scope of its binding (live and
        // visible ones; ADM1-04: a lapsed role shows nothing "from role").
        const grants = (await loadScopedPermissions(tx, member.id)).grants.filter((g) =>
          scopeVisible(g.scopeType, g.scopeId),
        );
        const roleKeys = [...new Set(grants.map((g) => g.key))];
        // Active overrides only (non-expired).
        const rawOverrides = await tx
          .select()
          .from(s.memberPermissionOverrides)
          .where(eq(s.memberPermissionOverrides.memberId, member.id));
        const now = new Date();
        const overrides = rawOverrides
          .filter((o) => !o.expiresAt || o.expiresAt > now)
          .filter((o) => scopeVisible(o.scopeType, o.scopeId))
          .map((o) => ({
            id: o.id,
            permissionKey: o.permissionKey,
            effect: o.effect as 'allow' | 'deny',
            scopeType: o.scopeType as 'global' | 'store',
            scopeId: o.scopeId,
            expiresAt: o.expiresAt?.toISOString() ?? null,
          }));
        // ADM1-05: resolved per scope, as every permission check does; a
        // store-scoped deny used to remove its key everywhere.
        const scoped = overrides.map((o) => ({
          key: o.permissionKey,
          effect: o.effect,
          scopeType: o.scopeType,
          scopeId: o.scopeId,
        }));
        return {
          memberId: member.id,
          roleKeys,
          overrides,
          effective: [...flatEffectivePermissions(grants, scoped)].sort(),
          byScope: permissionsByScope(grants, scoped),
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
        // ADM-21 (2026-10-30): an unknown key answered "no permission", and
        // a past expiry stored an override that never applied.
        const knownKey = await tx.query.permissions.findFirst({
          where: (p, { eq: eq2 }) => eq2(p.key, input.permissionKey),
        });
        if (!knownKey) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'admin.errors.unknownPermission' });
        }
        if (input.expiresAt && !(new Date(input.expiresAt).getTime() > Date.now())) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'admin.errors.invalidExpiresAt' });
        }
        // Global overrides change authority across the whole organization.
        // Store managers may manage their own store, but cannot mint or
        // alter organization-wide grants. An org-wide key (`org.admin`,
        // `dishes.manage`) is global-only even when cleaning up a malformed
        // historical row: in one store it would count nowhere (review
        // CONF-04).
        if (ORG_WIDE_PERMISSION_KEYS.has(input.permissionKey) && input.scopeType !== 'global') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'admin.errors.orgAdminMustBeGlobal',
          });
        }
        if (input.scopeType === 'global' || input.permissionKey === 'org.admin') {
          requireOrgAdmin(ctx.session!.permissions);
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
        // Global overrides are already guarded by requireOrgAdmin above.
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
            : await getActorMaxGlobalRank(tx, orgId, ctx.session!.userId);
        if (targetRank >= actorRank) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'admin.errors.targetOutranksYou',
          });
        }
        // An allow may only pass on authority the actor holds in that
        // same scope. Outranking the target is not enough: a manager
        // could otherwise equip a subordinate (or a second account of
        // their own) with keys their role was never given, and an admin
        // could hand out the super-admin-only ones.
        if (input.effect === 'allow') {
          // D8: the super admin and platform admins are not limited to
          // their own keys.
          const actorHoldsKey =
            (await exemptFromKeyCheck(tx, ctx)) ||
            (input.scopeType === 'store' && input.scopeId
              ? (
                  await effectivePermissionsForStore(
                    tx,
                    ctx.session!.memberId,
                    input.scopeId,
                    ctx.session!.permissions,
                  )
                ).has(input.permissionKey)
              : await hasGlobalPermission(tx, ctx.session!.memberId, input.permissionKey));
          if (!actorHoldsKey) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'auth.errors.missingPermission',
              cause: { missingPermission: input.permissionKey },
            });
          }
          // `org.admin` is what makes someone an admin, so allowing it
          // is granting the admin tier. grantRole forbids an admin from
          // creating another admin; this path must not be a way around it.
          if (input.permissionKey === 'org.admin' && actorRank <= ADMIN_RANK) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'auth.errors.cannotGrantEqualOrHigher',
            });
          }
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
              input.scopeId ? eq2(o.scopeId, input.scopeId) : sql`${o.scopeId} IS NULL`,
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
        // Mirror memberPermissionSet: only organization administrators may
        // revoke a global override, and only they may touch the reserved
        // org.admin key (including removal of a legacy store-scoped row).
        if (input.scopeType === 'global' || input.permissionKey === 'org.admin') {
          requireOrgAdmin(ctx.session!.permissions);
        }
        // C2 (2026-05-06): symmetric to `memberPermissionSet`. Store-
        // scoped revoke requires admin-of-store; global revoke was
        // organization-gated above.
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
            : await getActorMaxGlobalRank(tx, orgId, ctx.session!.userId);
        if (targetRank >= actorRank) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'admin.errors.targetOutranksYou',
          });
        }
        const removed = await tx
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
          )
          .returning({ id: s.memberPermissionOverrides.id });
        // ADM-21: nothing removed, nothing to audit.
        if (removed.length === 0) return { ok: true };
        await auditAdmin(tx, ctx, 'admin.memberPermission.revoke', 'permission', member.id, input);
        broadcastPeople(orgId);
        return { ok: true };
      });
    }),
};
