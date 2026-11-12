/**
 * Moving a session to another of the caller's organisations, and a
 * platform admin creating a new one.
 */
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import {
  inSystem,
  organizationSlugExists,
  organizationSlugFromName,
  provisionOrganization,
  schema as s,
  withSystemContext,
} from '@compass/db';
import { CreateOrganizationInputSchema, SwitchOrganizationInputSchema } from '@compass/contracts';
import { detectLocale } from '@compass/i18n';
import { authedProcedure } from '../../trpc';
import { isUniqueViolation } from '../../../services/pgErrors';
import { isPlatformAdmin } from '../../../services/platformAdmin';
import { endLeftRefreshChain, issueLoginResult } from './loginResult';

export const organizationProcedures = {
  /**
   * Switch the current access token to another organisation the same
   * user belongs to. The new refresh token is bound to that tenant, so
   * a later refresh cannot silently jump back to the first membership.
   */
  switchOrganization: authedProcedure
    .input(SwitchOrganizationInputSchema)
    .mutation(async ({ ctx, input }) => {
      const member = await inSystem(ctx.db, 'auth', (tx) =>
        tx.query.members.findFirst({
          where: (m, { eq: eq2, and: and2 }) =>
            and2(
              eq2(m.userId, ctx.session!.userId),
              eq2(m.orgId, input.orgId),
              eq2(m.status, 'active'),
            ),
        }),
      );
      if (!member) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'auth.errors.noMembership' });
      }
      await inSystem(ctx.db, 'auth', (tx) =>
        tx
          .update(s.users)
          .set({ lastOrgId: member.orgId })
          .where(eq(s.users.id, ctx.session!.userId)),
      );
      await endLeftRefreshChain(ctx);
      return issueLoginResult(
        ctx.db,
        ctx.session!.userId,
        member.id,
        member.orgId,
        ctx.ip,
        ctx.userAgent,
      );
    }),

  /**
   * Create a new tenant and make the caller its owner. This is the
   * self-service onboarding path: the first admin already has a usable
   * role ladder and feature defaults when the workspace opens.
   */
  createOrganization: authedProcedure
    .input(CreateOrganizationInputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!(await isPlatformAdmin(ctx.db, ctx.session!.userId))) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'auth.errors.platformAdminRequired',
        });
      }
      if (input.timezone) {
        try {
          new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format();
        } catch {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'auth.errors.invalidTimezone' });
        }
      }

      const user = await inSystem(ctx.db, 'auth', (tx) =>
        tx.query.users.findFirst({
          where: (u, { eq: eq2 }) => eq2(u.id, ctx.session!.userId),
        }),
      );
      if (!user) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });

      const slug = input.slug ?? organizationSlugFromName(input.name);
      let createdOrg: Awaited<ReturnType<typeof provisionOrganization>>;
      try {
        createdOrg = await withSystemContext(ctx.db, 'auth', async (tx) => {
          if (input.slug && (await organizationSlugExists(tx, slug))) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: 'auth.errors.orgSlugTaken' });
          }
          return provisionOrganization(tx, {
            name: input.name,
            slug,
            locale: detectLocale(input.locale ?? user.locale),
            timezone: input.timezone,
            ownerUserId: user.id,
          });
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'auth.errors.orgSlugTaken' });
        }
        throw err;
      }
      if (!createdOrg.ownerMemberId) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
      }
      await endLeftRefreshChain(ctx);
      return issueLoginResult(
        ctx.db,
        user.id,
        createdOrg.ownerMemberId,
        createdOrg.orgId,
        ctx.ip,
        ctx.userAgent,
      );
    }),
};
