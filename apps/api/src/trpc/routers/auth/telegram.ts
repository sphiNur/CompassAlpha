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
import { enforceRate } from './limits';
import {
  createTelegramUser,
  findTelegramUser,
  pickActiveMember,
  telegramUserOf,
  touchTelegramUser,
} from './identity';
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
      const { tg, isDevMock } = telegramUserOf(input.initData);

      const found = await inSystem(ctx.db, 'auth', (tx) => findTelegramUser(tx, tg));
      // A valid Telegram signature only proves who is asking, not that
      // they belong here. Membership comes from an invite
      // (admin.memberInviteByTgId) or `compass user grant`, both of which
      // create the user row up front — so an unknown Telegram id is a
      // stranger, and gets neither a user row nor a membership.
      if (!found && !isDevMock) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'auth.errors.noMembership' });
      }
      const user =
        found ??
        (await inSystem(ctx.db, 'auth', (tx) =>
          createTelegramUser(tx, tg, {
            locale: detectLocale(input.locale ?? tg.language_code),
            // A local mock is not a person who needs onboarding. Marking it
            // locked avoids creating an otherwise invisible first-run form
            // in browser automation.
            displayNameLocked: isDevMock,
          }),
        ));
      if (found) {
        await inSystem(ctx.db, 'auth', (tx) =>
          touchTelegramUser(tx, found, tg, {
            locale: detectLocale(input.locale ?? found.locale ?? tg.language_code),
          }),
        );
      }

      let ensuredMember = await inSystem(ctx.db, 'auth', (tx) => pickActiveMember(tx, user));
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
                and2(eq2(m.userId, user.id), eq2(m.status, 'suspended')),
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
