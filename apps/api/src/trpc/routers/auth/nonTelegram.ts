/**
 * Browser sign-in for remote development and staging checks: a Telegram
 * ID listed in NON_TELEGRAM_LOGIN_USERS, with its own access code. Never
 * on production (modes.ts).
 */
import { TRPCError } from '@trpc/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { inSystem, schema as s } from '@compass/db';
import { NonTelegramLoginInputSchema } from '@compass/contracts';
import { detectLocale } from '@compass/i18n';
import { publicProcedure } from '../../trpc';
import { logger } from '../../../infra/log';
import { enforceRate } from './limits';
import { isNonTelegramLoginAvailable, parseNonTelegramUsers } from './modes';
import { issueLoginResult } from './loginResult';

function digestSecret(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function secretsMatch(provided: string, expected: string): boolean {
  return timingSafeEqual(digestSecret(provided), digestSecret(expected));
}

function isAllowedNonTelegramUser(tgUserId: string, accessCode: string): boolean {
  if (!isNonTelegramLoginAvailable()) return false;
  const expected = parseNonTelegramUsers().get(tgUserId);
  if (!expected) return false;
  return secretsMatch(accessCode.trim(), expected);
}

export const nonTelegramProcedures = {
  /**
   * Browser-only login for remote development/staging UI checks.
   *
   * This deliberately does NOT create users. The requested Telegram ID
   * must already exist in auth.users and be explicitly listed in
   * NON_TELEGRAM_LOGIN_USERS with its own access code.
   */
  nonTelegramLogin: publicProcedure
    .input(NonTelegramLoginInputSchema)
    .mutation(async ({ ctx, input }) => {
      enforceRate('nonTelegramLogin', ctx.trustedIp);
      if (!isNonTelegramLoginAvailable()) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'auth.errors.nonTelegramLoginDisabled',
        });
      }
      if (!isAllowedNonTelegramUser(input.tgUserId, input.accessCode)) {
        logger.warn({ tgUserId: input.tgUserId, ip: ctx.ip }, 'auth.nonTelegramLogin rejected');
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'auth.errors.invalidNonTelegramLogin',
        });
      }

      const user = await inSystem(ctx.db, 'auth', (tx) =>
        tx.query.users.findFirst({
          where: (u, { eq: eq2 }) => eq2(u.tgUserId, BigInt(input.tgUserId)),
        }),
      );
      if (!user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'auth.errors.invalidNonTelegramLogin',
        });
      }

      const member = await inSystem(ctx.db, 'auth', async (tx) => {
        if (user.lastOrgId) {
          const remembered = await tx.query.members.findFirst({
            where: (m, { eq: eq2, and: and2 }) =>
              and2(eq2(m.userId, user.id), eq2(m.orgId, user.lastOrgId!), eq2(m.status, 'active')),
          });
          if (remembered) return remembered;
        }
        return tx.query.members.findFirst({
          where: (m, { eq: eq2, and: and2 }) =>
            and2(eq2(m.userId, user.id), eq2(m.status, 'active')),
        });
      });
      if (!member) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'auth.errors.noMembership' });
      }

      await inSystem(ctx.db, 'auth', (tx) =>
        tx
          .update(s.users)
          .set({
            locale: detectLocale(input.locale ?? user.locale),
            lastOrgId: member.orgId,
            lastSeenAt: new Date(),
          })
          .where(eq(s.users.id, user.id)),
      );

      return issueLoginResult(ctx.db, user.id, member.id, member.orgId, ctx.ip, ctx.userAgent);
    }),
};
