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
  ADMIN_RANK,
  MemberInviteRevokeInputSchema,
  InviteMemberByTgIdInputSchema,
  CreateMemberInviteInputSchema,
} from '@compass/contracts';
import { authedProcedure } from '../../trpc';
import {
  grantBinding,
  grantRefusal,
  inviterStillAuthorized,
  recipientRefusal,
  type GrantScope,
} from '../../../services/adminAuthority';
import { assertCanAddMember } from '../../../services/subscription';
import { requireAdmin } from './guards';
import { broadcastPeople } from './notify';
import {
  getActorAdminScope,
  storesAdministeredBy,
  notAdminOfStore,
  getAdminReadScope,
  inviteWithinScope,
  userInAnotherOrg,
} from './scope';
import {
  granterOf,
  assertCanGrantTo,
  assertCanInviteWithRole,
  assertCanInviteIntoStore,
  adminRankRoleIds,
} from './grants';
import { auditAdmin } from '../../../services/adminAudit';

export const inviteProcedures = {
  /**
   * Create a shareable invitation link.
   *
   * Unlike memberInviteByTgId, this does not need the person's
   * Telegram id up front. The link carries a one-time token; the
   * role/store grants are validated here and snapshotted on the
   * invite so acceptance cannot widen them later.
   */
  memberInviteCreate: authedProcedure
    .input(CreateMemberInviteInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        await assertCanAddMember(tx, orgId);
        const storeIds = [...new Set(input.storeIds)];
        const isAdminInvite = input.roleSlug === 'admin' || input.roleSlug === 'super_admin';
        if (!isAdminInvite && storeIds.length === 0) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'admin.errors.inviteNeedsStore',
          });
        }

        const adminScope = await getActorAdminScope(tx, orgId, ctx.session!.userId);
        const allowedStores = new Set(await storesAdministeredBy(tx, orgId, adminScope));
        for (const storeId of storeIds) {
          if (!allowedStores.has(storeId)) {
            throw await notAdminOfStore(tx, orgId, [storeId]);
          }
        }
        // ADM1-03: an org-tier invite needs admin authority held
        // organisation-wide. "Administers every active store" stood in
        // for it, which a store manager of a one-store org passes and a
        // global admin with one denied store fails.
        if (isAdminInvite && !adminScope?.isGlobalAdmin) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'admin.errors.cannotInviteOrgAdminAsStoreAdmin',
          });
        }

        const validStores =
          storeIds.length > 0
            ? await tx
                .select({
                  id: s.stores.id,
                  defaultRoleId: s.stores.defaultRoleId,
                })
                .from(s.stores)
                .where(
                  and(
                    eq(s.stores.orgId, orgId),
                    eq(s.stores.isActive, true),
                    inArray(s.stores.id, storeIds),
                  ),
                )
            : [];
        if (validStores.length !== storeIds.length) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'admin.errors.storeNotFound',
          });
        }

        const grants: Array<{
          roleId: string;
          rank: number;
          scopeType: 'global' | 'store';
          scopeId: string | null;
        }> = [];
        if (input.roleSlug) {
          const role = await tx.query.roles.findFirst({
            where: (r, { eq: eq2, and: and2 }) =>
              and2(eq2(r.orgId, orgId), eq2(r.slug, input.roleSlug!)),
          });
          if (!role) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'admin.errors.roleNotFound',
            });
          }
          if (await assertCanInviteWithRole(tx, ctx, role)) {
            grants.push({
              roleId: role.id,
              rank: role.rank,
              scopeType: 'global',
              scopeId: null,
            });
          } else {
            for (const storeId of storeIds) {
              // An invite with a role is a grant of it (C1, D8).
              await assertCanInviteIntoStore(tx, ctx, role, storeId);
              grants.push({
                roleId: role.id,
                rank: role.rank,
                scopeType: 'store',
                scopeId: storeId,
              });
            }
          }
        } else {
          // Same fall-through as memberInviteByTgId: a store's default
          // role applies only when the operator did not pick one, and
          // only if they can grant it there.
          for (const store of validStores) {
            if (!store.defaultRoleId) continue;
            const role = await tx.query.roles.findFirst({
              where: (r, { eq: eq2 }) => eq2(r.id, store.defaultRoleId!),
            });
            if (!role || role.rank >= ADMIN_RANK) continue;
            const scope = { type: 'store', storeId: store.id } as const;
            if (await grantRefusal(ctx.db, tx, granterOf(ctx), role, scope)) continue;
            grants.push({
              roleId: role.id,
              rank: role.rank,
              scopeType: 'store',
              scopeId: store.id,
            });
          }
        }

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
        const isAdminInvite = input.roleSlug === 'super_admin' || input.roleSlug === 'admin';
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
        const adminScope = await getActorAdminScope(tx, orgId, ctx.session!.userId);
        if (input.storeIds.length > 0) {
          const allowed = new Set(await storesAdministeredBy(tx, orgId, adminScope));
          for (const sid of input.storeIds) {
            if (!allowed.has(sid)) {
              throw await notAdminOfStore(tx, orgId, [sid]);
            }
          }
        }
        // Granting an org-tier role requires admin authority held
        // organisation-wide (ADM1-03; it used to be inferred from
        // "administers every active store").
        if (isAdminInvite && !adminScope?.isGlobalAdmin) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'admin.errors.cannotInviteOrgAdminAsStoreAdmin',
          });
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
          //   - Org-tier role (≥80) → global org admin, global rank (F8).
          //   - Sub-admin role → must outrank in EVERY target store.
          // The "every store" rule prevents a manager-of-A who's also
          // staff-of-B from inviting a manager-of-B (where A grants
          // them rank 30 but B only grants rank 10).
          const globalGrant = await assertCanInviteWithRole(tx, ctx, role);
          if (!globalGrant) {
            for (const storeId of input.storeIds) {
              await assertCanInviteIntoStore(tx, ctx, role, storeId);
            }
          }
          // ADM1-08: "inviting" someone already here (or oneself) is a
          // grant like grantRole's, to them as they are now.
          if (!created) {
            const scopes: GrantScope[] = globalGrant
              ? [{ type: 'global' }]
              : input.storeIds.map((storeId) => ({ type: 'store', storeId }));
            for (const scope of scopes) await assertCanGrantTo(tx, ctx, member.userId, scope);
          }
          // grantBinding is idempotent and renews a lapsed binding
          // (ADM1-04: one of those used to count as already held).
          if (role.rank >= ADMIN_RANK) {
            // Org-tier role → single global binding.
            await grantBinding(tx, {
              memberId: member.id,
              roleId: role.id,
              scope: { type: 'global' },
              grantedBy: ctx.session!.userId,
            });
          } else {
            // Sub-admin role → one binding per assigned store. The
            // `inviteNeedsStore` guard above already ensured storeIds is
            // non-empty for non-admin invites, so we can fan out here.
            for (const storeId of input.storeIds) {
              await grantBinding(tx, {
                memberId: member.id,
                roleId: role.id,
                scope: { type: 'store', storeId },
                grantedBy: ctx.session!.userId,
              });
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
              if (!role || role.rank >= ADMIN_RANK) continue;
              const scope = { type: 'store', storeId: store.id } as const;
              if (await grantRefusal(ctx.db, tx, granterOf(ctx), role, scope)) continue;
              // ADM1-08: nor to someone already here the actor does not outrank.
              if (
                !created &&
                (await recipientRefusal(ctx.db, tx, granterOf(ctx), member.userId, scope))
              ) {
                continue;
              }
              await grantBinding(tx, {
                memberId: member.id,
                roleId: role.id,
                scope,
                grantedBy: ctx.session!.userId,
              });
            }
          }
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
