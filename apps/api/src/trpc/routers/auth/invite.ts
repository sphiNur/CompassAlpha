/**
 * Accepting an invite link: signing in and joining the organisation in
 * one step.
 */
import { TRPCError } from '@trpc/server';
import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { inSystem, schema as s, withSystemContext } from '@compass/db';
import { AcceptInviteInputSchema } from '@compass/contracts';
import { detectLocale } from '@compass/i18n';
import { publicProcedure } from '../../trpc';
import { hub } from '../../../realtime/hub';
import {
  grantBinding,
  inviterStillAuthorized,
  liveInviteGrants,
  recipientRefusal,
} from '../../../services/adminAuthority';
import {
  assertCanAddMember,
  assertWriteAccess,
  readSubscriptionState,
} from '../../../services/subscription';
import { enforceRate } from './limits';
import {
  createTelegramUser,
  findTelegramUser,
  telegramUserOf,
  touchTelegramUser,
} from './identity';
import { issueLoginResult, withRefreshCookie } from './loginResult';

export const inviteProcedures = {
  /**
   * Accept a shareable invite link.
   *
   * The invite is the only path that may create a membership for a
   * Telegram user who is not already in this organisation. It is
   * intentionally a sign-in endpoint: Telegram supplies the identity,
   * and the high-entropy token supplies the membership grant.
   */
  acceptInvite: publicProcedure.input(AcceptInviteInputSchema).mutation(async ({ ctx, input }) => {
    enforceRate('acceptInvite', ctx.trustedIp);
    const { tg } = telegramUserOf(input.initData);

    const tokenHash = createHash('sha256').update(input.token).digest('hex');
    const identity = await withSystemContext(ctx.db, 'auth', async (tx) => {
      // Lock the invite before deciding whether it is unused. Two
      // people opening the same link at once must not both become
      // the accepted member.
      await tx.execute(
        sql`SELECT id FROM auth.member_invites WHERE token_hash = ${tokenHash} FOR UPDATE`,
      );
      const invite = await tx.query.memberInvites.findFirst({
        where: (i, { eq: eq2 }) => eq2(i.tokenHash, tokenHash),
      });
      if (!invite) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'auth.errors.inviteNotFound',
        });
      }
      // 2026-10-21 CA-19: an admin withdrew this link (only pending
      // invites can be revoked, so it was never accepted).
      if (invite.revokedAt) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'auth.errors.inviteRevoked',
        });
      }

      const found = await findTelegramUser(tx, tg);
      const user =
        found ??
        (await createTelegramUser(tx, tg, {
          locale: detectLocale(input.locale ?? tg.language_code),
          displayNameLocked: false,
        }));
      if (found) {
        await touchTelegramUser(tx, found, tg, {
          // Review COREWEB1-28 (2026-11-12): the language the user has
          // already (set in Settings, or at their first sign-in) wins
          // over the device's, which the web sends with the invite. A
          // row an administrator made has none yet and takes it.
          locale: detectLocale(found.locale ?? input.locale ?? tg.language_code),
          adoptName: true,
        });
      }

      if (invite.acceptedAt) {
        if (invite.acceptedByUserId !== user.id || !invite.acceptedByMemberId) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'auth.errors.inviteUsed',
          });
        }
        const acceptedMember = await tx.query.members.findFirst({
          where: (m, { eq: eq2, and: and2 }) =>
            and2(
              eq2(m.id, invite.acceptedByMemberId!),
              eq2(m.orgId, invite.orgId),
              eq2(m.status, 'active'),
            ),
        });
        if (!acceptedMember) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'auth.errors.inviteUsed',
          });
        }
        return {
          userId: user.id,
          memberId: acceptedMember.id,
          orgId: invite.orgId,
        };
      }

      if (invite.expiresAt.getTime() <= Date.now()) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'auth.errors.inviteExpired',
        });
      }

      // 2026-10-21 CA-19 (A-06): the link carries the inviter's authority,
      // so it lapses with it. A removed / suspended inviter, or one who no
      // longer holds users.manage over the invite's stores, voids every
      // link they handed out; so does one who could no longer make one of
      // its grants today (COREAPI-07: rank, org admin, keys).
      if (!(await inviterStillAuthorized(ctx.db, tx, { ...invite, grants: invite.grants ?? [] }))) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'auth.errors.inviteInviterNoLongerAuthorized',
        });
      }
      // ADM1-08 (2026-11-11): the link hands roles on with its inviter's
      // authority, so grantRole's rule on who may receive them applies
      // (recipientRefusal). An inviter opening their own link used to get
      // its roles, and kept the person it was meant for out.
      if (invite.invitedBy === user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'auth.errors.inviteOwnLink' });
      }

      assertWriteAccess(await readSubscriptionState(tx, invite.orgId));
      let member = await tx.query.members.findFirst({
        where: (m, { eq: eq2, and: and2 }) =>
          and2(eq2(m.orgId, invite.orgId), eq2(m.userId, user.id)),
      });
      if (member?.status === 'suspended') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'auth.errors.inviteMemberSuspended',
        });
      }
      // AUTH-28 (2026-10-30): an existing member opening an invite got its
      // stores and roles added with no word; the page now says which.
      const alreadyMember = member?.status === 'active';
      // Someone already in the workspace may hold roles the inviter does
      // not outrank (ADM1-08, below).
      const inviterMember =
        member && invite.invitedBy
          ? await tx.query.members.findFirst({
              where: (m, { eq: eq2, and: and2 }) =>
                and2(eq2(m.orgId, invite.orgId), eq2(m.userId, invite.invitedBy!)),
              columns: { id: true },
            })
          : undefined;
      if (!member) {
        await assertCanAddMember(tx, invite.orgId);
        const [createdMember] = await tx
          .insert(s.members)
          .values({
            orgId: invite.orgId,
            userId: user.id,
            status: 'active',
            invitedBy: invite.invitedBy,
          })
          .returning();
        member = createdMember;
      } else if (member.status !== 'active') {
        // 2026-10-21 audit CA-18: activating an inactive member takes a
        // seat exactly like creating one.
        await assertCanAddMember(tx, invite.orgId);
        const [reactivated] = await tx
          .update(s.members)
          .set({ status: 'active', updatedAt: new Date() })
          .where(eq(s.members.id, member.id))
          .returning();
        member = reactivated;
      }
      if (!member) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });

      const stores =
        invite.storeIds.length > 0
          ? await tx
              .select({ id: s.stores.id })
              .from(s.stores)
              .where(
                and(
                  eq(s.stores.orgId, invite.orgId),
                  eq(s.stores.isActive, true),
                  inArray(s.stores.id, invite.storeIds),
                ),
              )
          : [];
      const validStoreIds = new Set(stores.map((st) => st.id));
      for (const storeId of validStoreIds) {
        await tx
          .insert(s.memberStoreAssignments)
          .values({
            memberId: member.id,
            storeId,
            assignedBy: invite.invitedBy,
          })
          .onConflictDoNothing();
      }

      // The grants were validated when the invite was created, and the
      // inviter's authority over them again above. Grants whose role is
      // gone, was raised or changed tier are skipped (liveInviteGrants),
      // as are stores no longer open.
      for (const { grant, role } of await liveInviteGrants(tx, {
        orgId: invite.orgId,
        grants: invite.grants ?? [],
      })) {
        if (grant.scopeType === 'store' && (!grant.scopeId || !validStoreIds.has(grant.scopeId))) {
          continue;
        }
        const scope =
          grant.scopeType === 'store' && grant.scopeId
            ? ({ type: 'store', storeId: grant.scopeId } as const)
            : ({ type: 'global' } as const);
        // ADM1-08: a peer of the inviter, or someone above them, opening
        // the link got its roles too. Refused before anything is kept, so
        // the link still works for the person it was meant for.
        if (
          inviterMember &&
          (await recipientRefusal(
            ctx.db,
            tx,
            { orgId: invite.orgId, memberId: inviterMember.id, userId: invite.invitedBy! },
            user.id,
            scope,
          ))
        ) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'auth.errors.inviteSenderCannotGrantYou',
          });
        }
        // ADM1-04: a lapsed binding of the same role is renewed; it used
        // to count as held and the invite granted nothing.
        await grantBinding(tx, {
          memberId: member.id,
          roleId: role.id,
          scope,
          grantedBy: invite.invitedBy,
        });
      }

      await tx
        .update(s.memberInvites)
        .set({
          acceptedAt: new Date(),
          acceptedByUserId: user.id,
          acceptedByMemberId: member.id,
        })
        .where(eq(s.memberInvites.id, invite.id));

      return {
        userId: user.id,
        memberId: member.id,
        orgId: invite.orgId,
        alreadyMember,
      };
    });

    await inSystem(ctx.db, 'auth', (tx) =>
      tx.update(s.users).set({ lastOrgId: identity.orgId }).where(eq(s.users.id, identity.userId)),
    );
    hub.publish(identity.orgId, { type: 'people.changed', orgId: identity.orgId });
    const login = await issueLoginResult(
      ctx.db,
      identity.userId,
      identity.memberId,
      identity.orgId,
      ctx.ip,
      ctx.userAgent,
    );
    return withRefreshCookie(ctx, { ...login, alreadyMember: identity.alreadyMember });
  }),
};
