/** Members: the list, suspend and reactivate, rename, remove. */
import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema as s } from '@compass/db';
import {
  ADMIN_RANK,
  SUPER_ADMIN_RANK,
  MemberSetStatusInputSchema,
  MemberRemoveInputSchema,
  MemberSetDisplayNameInputSchema,
} from '@compass/contracts';
import { authedProcedure } from '../../trpc';
import { hub } from '../../../realtime/hub';
import { hasGlobalOrgAdmin } from '../../../services/orgAdmin';
import {
  bindingIsLive,
  countAdminsInOrg,
  getActorMaxGlobalRank,
  getActorMaxRank,
} from '../../../services/adminAuthority';
import { assertCanAddMember } from '../../../services/subscription';
import { requireAdmin, requireOrgAdmin } from './guards';
import { broadcastPeople } from './notify';
import {
  getAdminReadScope,
  visibleMemberIds,
  assertCanSetMemberStatus,
  assertAdministersEveryTargetStore,
  userInAnotherOrg,
  usersInOtherOrgs,
} from './scope';
import { memberStoreIdsForAudit, auditAdmin } from '../../../services/adminAudit';

export const memberProcedures = {
  // ============ MEMBERS ============

  memberList: authedProcedure.query(async ({ ctx }) => {
    requireAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      // 2026-10-21 CA-17: a non-org-admin sees only members of the stores
      // they administer (plus themself), only those stores on each card,
      // and no Telegram ids.
      const scope = await getAdminReadScope(tx, ctx.session!);
      const visible = scope ? await visibleMemberIds(tx, scope, ctx.session!.memberId) : null;
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
        .where(
          and(
            eq(s.members.orgId, orgId),
            ...(visible ? [inArray(s.members.id, [...visible])] : []),
          ),
        )
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
            roleRank: s.roles.rank,
            scopeType: s.memberRoleBindings.scopeType,
            scopeId: s.memberRoleBindings.scopeId,
          })
          .from(s.memberRoleBindings)
          .innerJoin(s.roles, eq(s.roles.id, s.memberRoleBindings.roleId))
          // ADM1-04: a lapsed binding grants nothing; the card showed it
          // as held (and the web ranked the member by it).
          .where(and(inArray(s.memberRoleBindings.memberId, memberIds), bindingIsLive())),
        tx
          .select({
            memberId: s.memberStoreAssignments.memberId,
            storeId: s.memberStoreAssignments.storeId,
          })
          .from(s.memberStoreAssignments)
          .where(inArray(s.memberStoreAssignments.memberId, memberIds)),
        // Paused and archived stores too (ADM1-16): their roles can still
        // be revoked, and a card named them as organisation-wide.
        tx
          .select({
            id: s.stores.id,
            name: s.stores.name,
            code: s.stores.code,
            isActive: s.stores.isActive,
            archived: sql<boolean>`${s.stores.deletedAt} IS NOT NULL`,
          })
          .from(s.stores)
          .where(eq(s.stores.orgId, orgId)),
      ]);

      const rolesByMember = new Map<
        string,
        Array<{
          bindingId: string;
          slug: string;
          name: string;
          /** CMP-ADM-1: lets the web hide actions the rank gates refuse. */
          rank: number;
          scopeType: string;
          scopeId: string | null;
        }>
      >();
      for (const b of bindings) {
        const arr = rolesByMember.get(b.memberId) ?? [];
        arr.push({
          bindingId: b.bindingId,
          slug: b.roleSlug,
          name: b.roleName,
          rank: b.roleRank,
          scopeType: b.scopeType,
          scopeId: b.scopeId,
        });
        rolesByMember.set(b.memberId, arr);
      }

      const storeById = new Map(allStores.map((st) => [st.id, st]));
      // ADM1-06: whose name only they may change (D22), so the web does
      // not offer to rename them.
      const nameShared = await usersInOtherOrgs(
        ctx,
        rows.map((r) => r.userId),
      );
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

      // Out-of-scope stores and store-scoped roles are dropped from other
      // members' cards; the actor's own card stays complete.
      const inScope = (memberId: string, storeId: string | null) =>
        scope === null || memberId === ctx.session!.memberId || (!!storeId && scope.has(storeId));
      return rows.map((r) => {
        const allStoreIds = [...(storesByMember.get(r.memberId) ?? [])];
        const storeIds = allStoreIds.filter((id) => inScope(r.memberId, id));
        // ADM-16: suspend / reactivate needs authority over every store the
        // member is in (assertCanSetMemberStatus). Say when that is out of
        // reach so the card doesn't offer an action the server refuses.
        const statusOutOfReach =
          scope !== null && (allStoreIds.length === 0 || storeIds.length < allStoreIds.length);
        const memberStores = storeIds
          .map((id) => storeById.get(id))
          .filter((st): st is NonNullable<typeof st> => !!st);
        return {
          memberId: r.memberId,
          userId: r.userId,
          tgUserId: scope === null && r.tgUserId !== null ? r.tgUserId.toString() : null,
          tgUsername: r.tgUsername,
          displayName: r.displayName,
          avatarUrl: r.avatarUrl,
          status: r.status,
          joinedAt: r.joinedAt.toISOString(),
          lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
          roles: (rolesByMember.get(r.memberId) ?? []).filter(
            (role) => role.scopeType !== 'store' || inScope(r.memberId, role.scopeId),
          ),
          stores: memberStores
            .filter((st) => st.isActive)
            .map((st) => ({ id: st.id, name: st.name, code: st.code })),
          inactiveStores: memberStores
            .filter((st) => !st.isActive)
            .map((st) => ({ id: st.id, name: st.name, archived: st.archived })),
          statusOutOfReach,
          nameShared: nameShared.has(r.userId),
        };
      });
    });
  }),

  memberSetStatus: authedProcedure
    .input(MemberSetStatusInputSchema)
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
        // Don't let an admin lock themselves out: refuse to suspend self.
        if (member.userId === ctx.session!.userId && input.status === 'suspended') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'admin.errors.cannotSuspendSelf',
          });
        }
        // Status is org-wide, so the actor needs authority over the
        // target everywhere the target has any. `users.manage` alone is
        // held by store managers and used to be the only gate here.
        await assertCanSetMemberStatus(tx, ctx.session!, member);
        // Last-admin guard for suspend. Serialised per org: two
        // concurrent suspends of the last two admins would otherwise
        // both read a count of 2.
        // 2026-10-21 audit CA-18: reactivating takes a seat like a new
        // member; usage counts only active members, so suspend → invite
        // → reactivate used to exceed the plan.
        if (input.status === 'active' && member.status !== 'active') {
          await assertCanAddMember(tx, orgId);
        }
        if (input.status === 'suspended') {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${orgId}))`);
          const targetMaxRank = await getActorMaxRank(tx, orgId, member.userId);
          if (targetMaxRank >= ADMIN_RANK) {
            const othersLeft = await countAdminsInOrg(tx, orgId, { memberId: member.id });
            if (othersLeft < 1) {
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
        await auditAdmin(tx, ctx, 'admin.member.setStatus', 'member', input.memberId, {
          ...input,
          memberStoreIds: await memberStoreIdsForAudit(tx, input.memberId),
        });
        // F7: a suspended member's open sockets stop receiving now.
        if (input.status !== 'active') hub.closeMember(orgId, input.memberId);
        broadcastPeople(orgId);
        return { ok: true };
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
        // D22 (2026-10-31, security scan F1): the name is shown in every
        // organisation the person belongs to. When another organisation
        // also has them, only the person may change it (renaming yourself
        // still works here); members of this organisation alone are
        // handled as before.
        if (member.id !== ctx.session!.memberId && (await userInAnotherOrg(ctx, member.userId))) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'admin.errors.displayNameSharedWithOtherOrg',
          });
        }
        // 2026-10-21 audit CA-07: the name lives on the global user row
        // (shown in every org the person belongs to), so `users.manage`
        // alone let a store manager rename an admin or another store's
        // staff. Org admins may rename anyone; everyone else needs the
        // same reach memberSetStatus demands.
        // ADM1-06 (2026-11-10): except over themself. A store manager
        // renaming themself failed the rank check against their own rank,
        // and this is the only way to change a name after onboarding.
        const self = member.id === ctx.session!.memberId;
        if (!self && !(await hasGlobalOrgAdmin(tx, ctx.session!.memberId))) {
          await assertAdministersEveryTargetStore(tx, ctx.session!, member);
        } else if (!self) {
          // 2026-10-21 rename rank: an org admin used to rename anyone,
          // including a fellow admin or the super_admin. Like status
          // changes, renaming someone else now needs a strictly higher
          // org-wide rank; super_admin may rename anyone, and everyone
          // may rename themself.
          const [targetRank, actorRank] = await Promise.all([
            getActorMaxRank(tx, orgId, member.userId),
            getActorMaxGlobalRank(tx, orgId, ctx.session!.userId),
          ]);
          if (actorRank < SUPER_ADMIN_RANK && targetRank >= actorRank) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'admin.errors.targetOutranksYou',
            });
          }
        }
        await tx
          .update(s.users)
          .set({
            displayName: input.displayName.trim(),
            displayNameLocked: true,
            updatedAt: new Date(),
          })
          .where(eq(s.users.id, member.userId));
        await auditAdmin(tx, ctx, 'admin.member.setDisplayName', 'member', member.id, {
          ...input,
          memberStoreIds: await memberStoreIdsForAudit(tx, member.id),
        });
        broadcastPeople(orgId);
        return { ok: true };
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
        where: (m, { eq: eq2, and: and2 }) => and2(eq2(m.id, input.memberId), eq2(m.orgId, orgId)),
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
      const actorRank = await getActorMaxGlobalRank(tx, orgId, ctx.session!.userId);
      if (targetMaxRank >= actorRank && targetMaxRank > 0) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'admin.errors.targetOutranksYou',
        });
      }
      // Last-admin guard. If the target is admin-level and they're
      // the only admin, refuse.
      if (targetMaxRank >= ADMIN_RANK) {
        const othersLeft = await countAdminsInOrg(tx, orgId, { memberId: member.id });
        if (othersLeft < 1) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'admin.errors.cannotRemoveLastAdmin',
          });
        }
      }
      // Attendance stays (owner decision 2026-11-07): someone with punches,
      // shifts, wages or overtime is suspended, not removed. The foreign
      // keys refuse it too (0068); this says so in words.
      const kept = await tx.execute(sql`
        SELECT 1 FROM inventory.attendance_punches WHERE member_id = ${member.id}
        UNION ALL SELECT 1 FROM inventory.attendance_shifts WHERE member_id = ${member.id}
        UNION ALL SELECT 1 FROM inventory.attendance_pay_rates WHERE member_id = ${member.id}
        UNION ALL SELECT 1 FROM inventory.attendance_overtime WHERE member_id = ${member.id}
        LIMIT 1`);
      if (kept.length > 0) {
        throw new TRPCError({ code: 'CONFLICT', message: 'admin.errors.memberHasAttendance' });
      }
      // Cascading deletes on member_role_bindings via FK ON DELETE CASCADE.
      // member_store_assignments cascades through the migration's FK.
      // 2026-10-21 audit CA-39: the member row (and its bindings) is
      // gone after this, so record who it was alongside the input.
      await auditAdmin(tx, ctx, 'admin.member.remove', 'member', member.id, {
        ...input,
        userId: member.userId,
        maxRank: targetMaxRank,
      });
      await tx.delete(s.members).where(eq(s.members.id, input.memberId));
      // F7: and so do a removed member's.
      hub.closeMember(orgId, input.memberId);
      broadcastPeople(orgId);
      return { ok: true };
    });
  }),
};
