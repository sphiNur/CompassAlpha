/**
 * Trading a refresh token for a new login token and the refresh token
 * that follows it.
 */
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { inSystem, schema as s } from '@compass/db';
import { RefreshInputSchema } from '@compass/contracts';
import { publicProcedure } from '../../trpc';
import { verifyRefresh } from '../../../infra/jwt';
import { logger } from '../../../infra/log';
import {
  rotateRefresh,
  RefreshReplayError,
  RefreshChainSwitchedError,
  RefreshNotFoundError,
} from '../../../services/refreshTokens';
import { buildSessionPayload } from '../../../services/sessionPayload';
import { env } from '../../../env';
import { readRefreshCookie } from '../../../http/refreshCookie';
import { enforceRate } from './limits';
import { pickActiveMember } from './identity';
import { loginResultFor, withRefreshCookie } from './loginResult';

export const refreshProcedures = {
  /**
   * Exchange a refresh token for a fresh access token (and optionally a
   * rotated refresh token).
   *
   * Why this exists: access tokens have a 15-min TTL by design. Without
   * refresh, anyone using the Mini App longer than that hits
   * `auth.errors.required` on every mutation — exactly the bug
   * production was throwing dozens of times per minute on 2026-05-03.
   *
   * Rotation strategy (M1 minimum-viable):
   *   - Verify the refresh JWT (signature + exp).
   *   - Reload the user + their first active membership to derive the
   *     new access claims (sub / org / mid).
   *   - Issue a NEW access token AND a fresh refresh token (same
   *     family) so the client can keep rotating indefinitely.
   *
   * Since then: tracked rotation with replay detection (M1.9), one
   * successor per token even when it is retried (AUTH-12), and no
   * untracked tokens (B12). See services/refreshTokens.ts.
   */
  refresh: publicProcedure.input(RefreshInputSchema).mutation(async ({ ctx, input }) => {
    enforceRate('refresh', ctx.trustedIp);
    let claims: {
      sub: string;
      family: string;
      jti: string | null;
      org: string | null;
      mid: string | null;
    };
    // Review MWD-14 (modern-web-guidance: privacy): the token in the body
    // (the Fine app, and the web app's own fallbacks) wins; otherwise the
    // HttpOnly cookie the sign-in set, read only when the request asks for
    // it (http/refreshCookie.ts). Rotation and replay detection below are
    // the same whichever carried it.
    const refreshToken =
      input.refreshToken ?? readRefreshCookie(ctx.hono, env.NODE_ENV === 'production');
    if (!refreshToken) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'auth.errors.invalidRefresh' });
    }
    try {
      claims = await verifyRefresh(refreshToken);
    } catch {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'auth.errors.invalidRefresh' });
    }

    // B12 (2026-10-30): only a tracked token can be exchanged. Tokens
    // without a jti predate M1.9 (2026-05-07) and their 30-day lifetime
    // ended long ago; every token issued since has its row written
    // before it is returned. A token whose row is gone (expired and
    // purged, or wiped) used to be "grandfathered" into a brand-new
    // family on every use, outside rotation and replay detection.
    if (!claims.jti) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'auth.errors.invalidRefresh' });
    }
    const jti = claims.jti;

    const user = await inSystem(ctx.db, 'auth', (tx) =>
      tx.query.users.findFirst({
        where: (u, { eq: eq2 }) => eq2(u.id, claims.sub),
      }),
    );
    if (!user) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'auth.errors.userMissing' });
    }
    const member = await inSystem(ctx.db, 'auth', async (tx) => {
      if (claims.org && claims.mid) {
        return tx.query.members.findFirst({
          where: (m, { eq: eq2, and: and2 }) =>
            and2(
              eq2(m.id, claims.mid!),
              eq2(m.orgId, claims.org!),
              eq2(m.userId, user.id),
              eq2(m.status, 'active'),
            ),
        });
      }
      // Refresh tokens from before tenant claims: the membership a
      // sign-in would open.
      return pickActiveMember(tx, user);
    });
    if (!member) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'auth.errors.noMembership' });
    }

    // Consume the token and get its successor in the same family:
    //   - Active: consumed, successor issued.
    //   - Consumed moments ago, successor still live: that same
    //     successor again (lost response, second tab) — AUTH-12.
    //   - Otherwise consumed: REPLAY — the whole family is revoked and
    //     the client has to sign in again.
    //   - Untracked or expired: refused (B12).
    let issued: Awaited<ReturnType<typeof rotateRefresh>>;
    try {
      issued = await rotateRefresh(ctx.db, {
        jti,
        family: claims.family,
        userId: user.id,
        orgId: member.orgId,
        memberId: member.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    } catch (err) {
      if (err instanceof RefreshChainSwitchedError) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'auth.errors.refreshChainSwitched',
        });
      }
      if (err instanceof RefreshReplayError) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'auth.errors.refreshReplayDetected',
        });
      }
      if (err instanceof RefreshNotFoundError) {
        logger.warn(
          { sub: claims.sub, family: claims.family, jti },
          'auth.refresh: refresh token not tracked or expired — refused',
        );
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'auth.errors.invalidRefresh' });
      }
      throw err;
    }

    const session = await buildSessionPayload(ctx.db, user.id, member.id, member.orgId);
    await inSystem(ctx.db, 'auth', (tx) =>
      tx.update(s.users).set({ lastOrgId: member.orgId }).where(eq(s.users.id, user.id)),
    );
    return withRefreshCookie(ctx, await loginResultFor(user.id, member.id, session, issued));
  }),
};
