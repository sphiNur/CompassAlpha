/** The stores a member works in: assign, unassign, detach, transfer. */
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s } from '@compass/db';
import {
  ADMIN_RANK,
  UuidSchema,
  MemberAssignStoreInputSchema,
  MemberUnassignStoreInputSchema,
  MemberDetachFromStoreInputSchema,
  MemberTransferStoreInputSchema,
} from '@compass/contracts';
import { authedProcedure } from '../../trpc';
import {
  bindingIsLive,
  grantBinding,
  getActorMaxRank,
  getActorMaxRankInStore,
} from '../../../services/adminAuthority';
import { requireAdmin } from './guards';
import { broadcastPeople } from './notify';
import {
  getActorAdminStoreIds,
  notAdminOfStore,
  getAdminReadScope,
  visibleMemberIds,
} from './scope';
import { assertCanGrantTo, assertCanPassOnRole } from './grants';
import { auditAdmin } from '../../../services/adminAudit';

export const memberStoreProcedures = {
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
        // 2026-10-21 CA-17: outside org admins, only members of stores the
        // actor administers, and only those stores.
        const scope = await getAdminReadScope(tx, ctx.session!);
        const isSelf = member.id === ctx.session!.memberId;
        if (scope && !isSelf) {
          const visible = await visibleMemberIds(tx, scope, ctx.session!.memberId);
          if (!visible.has(member.id)) {
            throw new TRPCError({ code: 'FORBIDDEN', message: 'admin.errors.notAdminOfStore' });
          }
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
        return rows
          .filter((r) => !scope || isSelf || scope.has(r.storeId))
          .map((r) => ({
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
          throw await notAdminOfStore(tx, orgId, [input.storeId]);
        }
        await tx
          .insert(s.memberStoreAssignments)
          .values({
            memberId: input.memberId,
            storeId: input.storeId,
            assignedBy: ctx.session!.userId,
          })
          .onConflictDoNothing();
        await auditAdmin(tx, ctx, 'admin.memberAssignStore', 'member', member.id, input);
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
        // administers. Symmetric to memberAssignStore, but a paused or
        // archived store counts: a removal (R2-ADM-2, ADM1-16).
        const allowedStores = await getActorAdminStoreIds(tx, orgId, ctx.session!.userId, {
          includeInactive: true,
        });
        if (!allowedStores.includes(input.storeId)) {
          throw await notAdminOfStore(tx, orgId, [input.storeId]);
        }
        // 2026-10-21 audit A-11: same in-store rank gate as
        // memberDetachFromStore — a manager could otherwise unassign a
        // peer or superior from their shared store.
        const [targetRankInStore, actorRankInStore] = await Promise.all([
          getActorMaxRankInStore(tx, orgId, member.userId, input.storeId),
          getActorMaxRankInStore(tx, orgId, ctx.session!.userId, input.storeId),
        ]);
        if (targetRankInStore >= actorRankInStore) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'auth.errors.cannotRevokeEqualOrHigher',
          });
        }
        // SECURITY (2026-05-04): non-admin members must keep at least one
        // store assignment, otherwise they appear "active" but every
        // store-scoped query returns empty and they can't do anything.
        // Admins (rank ≥ 80) bypass via the assertActorAssignedToStore
        // admin-bypass and don't need an assignment to function.
        const targetMaxRank = await getActorMaxRank(tx, orgId, member.userId);
        if (targetMaxRank < ADMIN_RANK) {
          const remaining = await tx
            .select({ storeId: s.memberStoreAssignments.storeId })
            .from(s.memberStoreAssignments)
            .where(eq(s.memberStoreAssignments.memberId, input.memberId));
          // After this delete, count would drop to (remaining-1). Refuse
          // if removing this assignment would leave them with zero.
          const willRemain = remaining.filter((r) => r.storeId !== input.storeId).length;
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
        await auditAdmin(tx, ctx, 'admin.memberUnassignStore', 'member', member.id, input);
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
   * store in their session (services/sessionPayload.ts: binding
   * scopeIds count too) and
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
        // C2: must administer the store you're detaching from. R2-ADM-2:
        // an archived store counts, so its leftover bindings can be cleared.
        const allowed = await getActorAdminStoreIds(tx, orgId, ctx.session!.userId, {
          includeInactive: true,
        });
        if (!allowed.includes(input.storeId)) {
          throw await notAdminOfStore(tx, orgId, [input.storeId]);
        }
        // C1: rank gate evaluated in this store. A manager-rank-30 of
        // Store A cannot detach a manager-rank-30 of Store A — same
        // rule as revokeRole, applied to all bindings we're about to
        // delete plus the MSA row.
        const targetRank = await getActorMaxRankInStore(tx, orgId, member.userId, input.storeId);
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
        // A paused or archived store gives nobody anything, so leaving it
        // cannot strand the member.
        const targetMaxRank = await getActorMaxRank(tx, orgId, member.userId);
        if (targetMaxRank < ADMIN_RANK && store.isActive) {
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
                  bindingIsLive(),
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
        await auditAdmin(tx, ctx, 'admin.memberDetachFromStore', 'member', member.id, {
          ...input,
          revokedBindings: revokedBindings.length,
          revokedOverrides: revokedOverrides.length,
        });
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
        // ADM1-16: leaving a paused or archived store is a removal;
        // joining one is not allowed. Each side answers for itself.
        const allowed = await getActorAdminStoreIds(tx, orgId, ctx.session!.userId, {
          includeInactive: true,
        });
        if (!allowed.includes(input.fromStoreId)) {
          throw await notAdminOfStore(tx, orgId, [input.fromStoreId]);
        }
        if (!toStore.isActive || !allowed.includes(input.toStoreId)) {
          throw await notAdminOfStore(tx, orgId, [input.toStoreId]);
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
        // ADM-23 (2026-10-30): "transferring" someone out of a store they
        // were never in was a plain assignment in disguise.
        const [inSource] = await tx
          .select({ storeId: s.memberStoreAssignments.storeId })
          .from(s.memberStoreAssignments)
          .where(
            and(
              eq(s.memberStoreAssignments.memberId, input.memberId),
              eq(s.memberStoreAssignments.storeId, input.fromStoreId),
            ),
          )
          .limit(1);
        // Pull the bindings to mirror. Even if mirrorRoles=false we
        // still need the count for the audit log. ADM1-04: live ones
        // only, each with its expiry; a role granted until some date
        // used to arrive in the destination for good.
        const fromBindings = await tx
          .select({
            id: s.memberRoleBindings.id,
            roleId: s.memberRoleBindings.roleId,
            roleRank: s.roles.rank,
            expiresAt: s.memberRoleBindings.expiresAt,
          })
          .from(s.memberRoleBindings)
          .innerJoin(s.roles, eq(s.roles.id, s.memberRoleBindings.roleId))
          .where(
            and(
              eq(s.memberRoleBindings.memberId, input.memberId),
              eq(s.memberRoleBindings.scopeType, 'store'),
              eq(s.memberRoleBindings.scopeId, input.fromStoreId),
              bindingIsLive(),
            ),
          );
        if (!inSource && fromBindings.length === 0) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'admin.errors.memberNotInSourceStore',
          });
        }
        if (input.mirrorRoles && fromBindings.length > 0) {
          // ADM1-08: mirroring gives the member roles in the destination,
          // where they may already stand as high as the actor.
          await assertCanGrantTo(tx, ctx, member.userId, {
            type: 'store',
            storeId: input.toStoreId,
          });
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
            // Security scan F9 (2026-10-31): mirroring is a grant in the
            // destination, so D8 applies there too: the actor must hold
            // the role's keys in that store, or a key held only in the
            // source store could be carried across.
            await assertCanPassOnRole(tx, ctx, b.roleId, input.toStoreId);
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
            // exist (e.g. a previous transfer attempt); a live one stays.
            const { outcome } = await grantBinding(tx, {
              memberId: member.id,
              roleId: b.roleId,
              scope: { type: 'store', storeId: input.toStoreId },
              grantedBy: ctx.session!.userId,
              expiresAt: b.expiresAt,
            });
            if (outcome !== 'held') mirrored++;
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
        await auditAdmin(tx, ctx, 'admin.memberTransferStore', 'member', member.id, {
          ...input,
          mirrored,
          revokedBindings: revokedBindings.length,
          revokedOverrides: revokedOverrides.length,
        });
        broadcastPeople(orgId);
        return {
          ok: true,
          mirrored,
          revokedBindings: revokedBindings.length,
          revokedOverrides: revokedOverrides.length,
        };
      });
    }),
};
