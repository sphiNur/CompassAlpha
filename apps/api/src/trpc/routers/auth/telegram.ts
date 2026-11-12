/**
 * Sign-in from the Telegram Mini App: Telegram vouches for who is asking
 * (initData), and a membership they already hold decides where they land.
 */
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { inSystem, schema as s, withOrgContext, type DB } from '@compass/db';
import { TelegramLoginInputSchema } from '@compass/contracts';
import { detectLocale } from '@compass/i18n';
import { publicProcedure } from '../../trpc';
import { verifyInitData, type TelegramUser } from '../../../services/telegramAuth';
import { env } from '../../../env';
import { enforceRate } from './limits';
import { DEV_MOCK_INIT_DATA, DEV_MOCK_TG_USER, isDevMockLoginAvailable } from './modes';
import { issueLoginResult } from './loginResult';

function ensureDevMockAdminAccess(db: DB, memberId: string, orgId: string): Promise<void> {
  return withOrgContext(db, orgId, (tx) => grantDevMockAdmin(tx, memberId, orgId));
}

async function grantDevMockAdmin(db: DB, memberId: string, orgId: string): Promise<void> {
  const role = await db.query.roles.findFirst({
    where: (r, { and: and2, eq: eq2 }) => and2(eq2(r.orgId, orgId), eq2(r.slug, 'super_admin')),
  });
  if (!role) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'auth.errors.devMockSeedRequired',
    });
  }
  const binding = await db.query.memberRoleBindings.findFirst({
    where: (b, { and: and2, eq: eq2, isNull: isNull2 }) =>
      and2(
        eq2(b.memberId, memberId),
        eq2(b.roleId, role.id),
        eq2(b.scopeType, 'global'),
        isNull2(b.scopeId),
      ),
  });
  if (!binding) {
    await db
      .insert(s.memberRoleBindings)
      .values({
        memberId,
        roleId: role.id,
        scopeType: 'global',
      })
      .onConflictDoNothing();
  }
}

export const telegramProcedures = {
  /** Login via Telegram Mini App initData. */
  telegramLogin: publicProcedure
    .input(TelegramLoginInputSchema)
    .mutation(async ({ ctx, input }) => {
      enforceRate('login', ctx.trustedIp);
      const isDevMock = input.initData === DEV_MOCK_INIT_DATA && isDevMockLoginAvailable();
      let tg: TelegramUser;
      if (isDevMock) {
        tg = DEV_MOCK_TG_USER;
      } else {
        if (!env.TELEGRAM_BOT_TOKEN) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'auth.errors.botTokenMissing',
          });
        }
        const result = verifyInitData(input.initData, env.TELEGRAM_BOT_TOKEN);
        if (!result.ok || !result.user) {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'auth.errors.invalidInitData' });
        }
        tg = result.user;
      }

      // Upsert user.
      let user = await inSystem(ctx.db, 'auth', (tx) =>
        tx.query.users.findFirst({
          where: (u, { eq: eq2 }) => eq2(u.tgUserId, BigInt(tg.id)),
        }),
      );
      // A valid Telegram signature only proves who is asking, not that
      // they belong here. Membership comes from an invite
      // (admin.memberInviteByTgId) or `compass user grant`, both of which
      // create the user row up front — so an unknown Telegram id is a
      // stranger, and gets neither a user row nor a membership.
      if (!user && !isDevMock) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'auth.errors.noMembership' });
      }
      if (!user) {
        const [created] = await inSystem(ctx.db, 'auth', (tx) =>
          tx
            .insert(s.users)
            .values({
              tgUserId: BigInt(tg.id),
              tgUsername: tg.username ?? null,
              displayName:
                [tg.first_name, tg.last_name].filter(Boolean).join(' ') ||
                tg.username ||
                `user-${tg.id}`,
              avatarUrl: tg.photo_url ?? null,
              locale: detectLocale(input.locale ?? tg.language_code),
              // A local mock is not a person who needs onboarding. Marking it
              // locked avoids creating an otherwise invisible first-run form
              // in browser automation.
              displayNameLocked: isDevMock,
            })
            .returning(),
        );
        user = created;
      } else {
        // Read through a constant: `user` is reassigned above, so inside the
        // callback the compiler no longer knows it is set.
        const known = user;
        await inSystem(ctx.db, 'auth', (tx) =>
          tx
            .update(s.users)
            .set({
              tgUsername: tg.username ?? known.tgUsername,
              avatarUrl: tg.photo_url ?? known.avatarUrl,
              locale: detectLocale(input.locale ?? known.locale ?? tg.language_code),
              lastSeenAt: new Date(),
            })
            .where(eq(s.users.id, known.id)),
        );
      }
      if (!user) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });

      const findActiveMember = () =>
        inSystem(ctx.db, 'auth', async (tx) => {
          if (user!.lastOrgId) {
            const remembered = await tx.query.members.findFirst({
              where: (m, { eq: eq2, and: and2 }) =>
                and2(
                  eq2(m.userId, user!.id),
                  eq2(m.orgId, user!.lastOrgId!),
                  eq2(m.status, 'active'),
                ),
            });
            if (remembered) return remembered;
          }
          return tx.query.members.findFirst({
            where: (m, { eq: eq2, and: and2 }) =>
              and2(eq2(m.userId, user!.id), eq2(m.status, 'active')),
          });
        });
      let ensuredMember = await findActiveMember();
      if (!ensuredMember) {
        // Only the local dev mock self-enrols. This used to run for every
        // caller, which made the bot's audience the org's membership and
        // quietly re-admitted anyone an admin had removed.
        if (!isDevMock) {
          // AUTH-19 (2026-10-30): a suspended member was told they had not
          // been added to any store yet; say what actually happened.
          const suspended = await inSystem(ctx.db, 'auth', (tx) =>
            tx.query.members.findFirst({
              where: (m, { eq: eq2, and: and2 }) =>
                and2(eq2(m.userId, user!.id), eq2(m.status, 'suspended')),
              columns: { id: true },
            }),
          );
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: suspended ? 'auth.errors.membershipSuspended' : 'auth.errors.noMembership',
          });
        }
        const defaultOrg = await inSystem(ctx.db, 'auth', (tx) =>
          tx.query.organizations.findFirst({
            where: (o, { eq: eq2 }) => eq2(o.slug, 'default'),
          }),
        );
        if (!defaultOrg) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'auth.errors.noOrg' });
        }
        [ensuredMember] = await inSystem(ctx.db, 'auth', (tx) =>
          tx.insert(s.members).values({ orgId: defaultOrg.id, userId: user.id }).returning(),
        );
        if (!ensuredMember) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
      }
      if (isDevMock) {
        await ensureDevMockAdminAccess(ctx.db, ensuredMember.id, ensuredMember.orgId);
      }
      await inSystem(ctx.db, 'auth', (tx) =>
        tx.update(s.users).set({ lastOrgId: ensuredMember.orgId }).where(eq(s.users.id, user.id)),
      );

      // M1.9 (2026-05-07): refresh tokens are tracked in auth.refresh_tokens
      // with rotation lineage + replay detection.
      return issueLoginResult(
        ctx.db,
        user.id,
        ensuredMember.id,
        ensuredMember.orgId,
        ctx.ip,
        ctx.userAgent,
      );
    }),
};
