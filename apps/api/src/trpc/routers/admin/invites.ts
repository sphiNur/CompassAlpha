/**
 * Invitations: links anyone with the link can accept
 * (memberInviteCreate), and direct ones by Telegram ID
 * (memberInviteByTgId); the pending list and withdrawing one.
 */
import { TRPCError } from '@trpc/server';
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { schema as s } from '@compass/db';
import {
  MemberInviteRevokeInputSchema,
  InviteMemberByTgIdInputSchema,
  CreateMemberInviteInputSchema,
} from '@compass/contracts';
import { authedProcedure } from '../../trpc';
import {
  grantBinding,
  inviterStillAuthorized,
  recipientRefusal,
  type GrantScope,
} from '../../../services/adminAuthority';
import { assertCanAddMember } from '../../../services/subscription';
import { requireAdmin } from './guards';
import { broadcastPeople } from './notify';
import { getAdminReadScope, inviteWithinScope, userInAnotherOrg } from './scope';
import { granterOf, assertCanGrantTo, adminRankRoleIds } from './grants';
import { auditAdmin } from '../../../services/adminAudit';
import { planInvite } from './invitePlan';

export const inviteProcedures = {
  /**
   * Create a shareable invitation link.
   *
   * Unlike memberInviteByTgId, this does not need the person's Telegram
   * id up front. The link carries a one-time token. The stores and role
   * grants are decided as for an invite by Telegram ID (planInvite,
   * ADM1-12) and kept on the invite, so opening the link cannot widen
   * them.
   */
  memberInviteCreate: authedProcedure
    .input(CreateMemberInviteInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        await assertCanAddMember(tx, orgId);
        const { storeIds, grants } = await planInvite(tx, ctx, input);

        const token = `inv_${randomBytes(32).toString('base64url')}`;
        const tokenHash = createHash('sha256').update(token).digest('hex');
        const expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);
        const [invite] = await tx
          .insert(s.memberInvites)
          .values({
            orgId,
            invitedBy: ctx.session!.userId,
            tokenHash,
            storeIds,
            grants,
            expiresAt,
          })
          .returning({ id: s.memberInvites.id });
        if (!invite) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'admin.errors.inviteCreateFailed',
          });
        }
        // Deliberately omit the raw token from the audit payload.
        await auditAdmin(tx, ctx, 'admin.memberInviteCreate', 'member_invite', invite.id, {
          storeIds,
          roleSlug: input.roleSlug ?? null,
          expiresAt: expiresAt.toISOString(),
          grantCount: grants.length,
        });
        return { token, expiresAt: expiresAt.toISOString() };
      });
    }),

  /**
   * 2026-10-21 CA-19 (A-06): pending shareable invite links — not
   * accepted, not revoked, not expired. Org admins see all of them;
   * anyone else only invites whose stores they all administer
   * (`inviteWithinScope`). The token itself is never stored, so it is
   * never returned.
   */
  memberInviteList: authedProcedure.query(async ({ ctx }) => {
    requireAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      const scope = await getAdminReadScope(tx, ctx.session!);
      const rows = await tx
        .select({
          id: s.memberInvites.id,
          storeIds: s.memberInvites.storeIds,
          grants: s.memberInvites.grants,
          expiresAt: s.memberInvites.expiresAt,
          createdAt: s.memberInvites.createdAt,
          invitedBy: s.memberInvites.invitedBy,
          inviterName: s.users.displayName,
        })
        .from(s.memberInvites)
        .leftJoin(s.users, eq(s.users.id, s.memberInvites.invitedBy))
        .where(
          and(
            eq(s.memberInvites.orgId, orgId),
            isNull(s.memberInvites.acceptedAt),
            isNull(s.memberInvites.revokedAt),
            gt(s.memberInvites.expiresAt, new Date()),
          ),
        )
        .orderBy(desc(s.memberInvites.createdAt));
      // ADM-14 (2026-10-30): a store-tier admin saw (and could revoke)
      // links that hand out admin-rank roles; those are for org admins.
      const adminRoleIds = scope === null ? new Set<string>() : await adminRankRoleIds(tx, orgId);
      const inScope = rows.filter(
        (r) =>
          inviteWithinScope(r.storeIds, scope) &&
          !(r.grants ?? []).some((g) => adminRoleIds.has(g.roleId)),
      );
      // ADM-15 (2026-10-30): links whose inviter has since lost the
      // authority are refused on accept; stop listing them as pending.
      const visible: typeof inScope = [];
      for (const r of inScope) {
        const invite = {
          orgId,
          invitedBy: r.invitedBy,
          storeIds: r.storeIds,
          grants: r.grants ?? [],
        };
        if (await inviterStillAuthorized(ctx.db, tx, invite)) {
          visible.push(r);
        }
      }
      if (visible.length === 0) return [];
      const storeIds = [...new Set(visible.flatMap((r) => r.storeIds))];
      const roleIds = [...new Set(visible.flatMap((r) => (r.grants ?? []).map((g) => g.roleId)))];
      const [stores, roles] = await Promise.all([
        storeIds.length > 0
          ? tx
              .select({ id: s.stores.id, name: s.stores.name })
              .from(s.stores)
              .where(and(eq(s.stores.orgId, orgId), inArray(s.stores.id, storeIds)))
          : Promise.resolve([] as Array<{ id: string; name: string }>),
        roleIds.length > 0
          ? tx
              .select({ id: s.roles.id, slug: s.roles.slug, name: s.roles.name })
              .from(s.roles)
              .where(and(eq(s.roles.orgId, orgId), inArray(s.roles.id, roleIds)))
          : Promise.resolve([] as Array<{ id: string; slug: string; name: string }>),
      ]);
      const storeById = new Map(stores.map((st) => [st.id, st]));
      const roleById = new Map(roles.map((r) => [r.id, r]));
      return visible.map((r) => {
        const roleSet = new Map<string, { slug: string; name: string }>();
        for (const g of r.grants ?? []) {
          const role = roleById.get(g.roleId);
          if (role) roleSet.set(role.id, { slug: role.slug, name: role.name });
        }
        return {
          id: r.id,
          /** ADM-15: a granted role that has since been deleted. */
          roleDeleted: (r.grants ?? []).some((g) => !roleById.has(g.roleId)),
          stores: r.storeIds
            .map((id) => storeById.get(id))
            .filter((st): st is NonNullable<typeof st> => !!st),
          roles: [...roleSet.values()],
          invitedBy: r.invitedBy ? { userId: r.invitedBy, displayName: r.inviterName } : null,
          createdAt: r.createdAt.toISOString(),
          expiresAt: r.expiresAt.toISOString(),
        };
      });
    });
  }),

  /**
   * 2026-10-21 CA-19 (A-06): withdraw a pending invite link. Same reach
   * as the list. The conditional UPDATE races safely with
   * auth.acceptInvite (which locks the row FOR UPDATE): whichever
   * commits first wins and the other sees a non-pending invite.
   */
  memberInviteRevoke: authedProcedure
    .input(MemberInviteRevokeInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const invite = await tx.query.memberInvites.findFirst({
          where: (i, { eq: eq2, and: and2 }) =>
            and2(eq2(i.id, input.inviteId), eq2(i.orgId, orgId)),
        });
        if (!invite) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.inviteNotFound' });
        }
        const scope = await getAdminReadScope(tx, ctx.session!);
        if (!inviteWithinScope(invite.storeIds, scope)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'admin.errors.notAdminOfStore' });
        }
        if (scope !== null) {
          const adminRoleIds = await adminRankRoleIds(tx, orgId);
          if ((invite.grants ?? []).some((g) => adminRoleIds.has(g.roleId))) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'auth.errors.cannotRevokeEqualOrHigher',
            });
          }
        }
        const [revoked] = await tx
          .update(s.memberInvites)
          .set({ revokedAt: new Date(), revokedBy: ctx.session!.userId })
          .where(
            and(
              eq(s.memberInvites.id, invite.id),
              isNull(s.memberInvites.acceptedAt),
              isNull(s.memberInvites.revokedAt),
            ),
          )
          .returning({ id: s.memberInvites.id });
        if (!revoked) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'admin.errors.inviteNotPending' });
        }
        await auditAdmin(tx, ctx, 'admin.memberInviteRevoke', 'member_invite', invite.id, {
          storeIds: invite.storeIds,
          expiresAt: invite.expiresAt.toISOString(),
        });
        broadcastPeople(orgId);
        return { ok: true as const };
      });
    }),

  /**
   * Invite a member by Telegram user ID. A new person gets a user row
   * (their name is filled in at their first /start) and a membership.
   * The stores and role grants are decided as for an invite link
   * (planInvite, ADM1-12), before anyone is created, and given at once:
   * the member can work before they ever open the app.
   *
   * Calling it again for someone already here returns the same memberId
   * and adds what they lack; what they hold stays as it is.
   */
  memberInviteByTgId: authedProcedure
    .input(InviteMemberByTgIdInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const plan = await planInvite(tx, ctx, input);
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
        } else if (
          input.displayName &&
          user.displayName.startsWith('tg:') &&
          // D22: not a name another organisation also shows.
          !(await userInAnotherOrg(ctx, user.id))
        ) {
          // Existing placeholder — update with the more useful name.
          await tx
            .update(s.users)
            .set({ displayName: input.displayName })
            .where(eq(s.users.id, user.id));
        }
        if (!user) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'admin.errors.userCreateFailed',
          });
        }
        // Find or create the member.
        let member = await tx.query.members.findFirst({
          where: (m, { eq: eq2, and: and2 }) => and2(eq2(m.orgId, orgId), eq2(m.userId, user.id)),
        });
        const created = !member;
        // ADM-19 (2026-10-30): "inviting" a suspended member silently added
        // roles and stores while they stayed suspended. Reactivate first.
        if (member && member.status !== 'active') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'admin.errors.memberInactiveReactivateFirst',
          });
        }
        if (!member) {
          await assertCanAddMember(tx, orgId);
          const [m] = await tx
            .insert(s.members)
            .values({ orgId, userId: user.id, status: 'active', invitedBy: ctx.session!.userId })
            .returning();
          member = m;
        }
        if (!member) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'admin.errors.memberCreateFailed',
          });
        }
        // ADM1-08: "inviting" someone already here (or oneself) is a grant
        // like grantRole's, to them as they are now. The role the actor
        // picked is refused; a store's default role is left out.
        const bindings: Array<{ roleId: string; scope: GrantScope }> = [];
        for (const grant of plan.grants) {
          const scope: GrantScope =
            grant.scopeType === 'store' && grant.scopeId
              ? { type: 'store', storeId: grant.scopeId }
              : { type: 'global' };
          if (!created) {
            if (plan.picked) {
              await assertCanGrantTo(tx, ctx, member.userId, scope);
            } else if (await recipientRefusal(ctx.db, tx, granterOf(ctx), member.userId, scope)) {
              continue;
            }
          }
          bindings.push({ roleId: grant.roleId, scope });
        }
        for (const storeId of plan.storeIds) {
          await tx
            .insert(s.memberStoreAssignments)
            .values({ memberId: member.id, storeId, assignedBy: ctx.session!.userId })
            .onConflictDoNothing();
        }
        // grantBinding is idempotent and renews a lapsed binding (ADM1-04:
        // one of those used to count as already held).
        for (const { roleId, scope } of bindings) {
          await grantBinding(tx, {
            memberId: member.id,
            roleId,
            scope,
            grantedBy: ctx.session!.userId,
          });
        }
        await auditAdmin(tx, ctx, 'admin.memberInviteByTgId', 'member', member.id, {
          ...input,
          tgUserId: input.tgUserId.toString(),
          userId: user.id,
          created,
        });
        broadcastPeople(orgId);
        return { memberId: member.id, userId: user.id, created };
      });
    }),
};
