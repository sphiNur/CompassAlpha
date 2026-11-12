/**
 * What every sign-in returns (a login token, a refresh token and the
 * session), and ending the refresh chain a session moves away from.
 */
import type { DB } from '@compass/db';
import { signAccess } from '../../../infra/jwt';
import { issueRefresh, revokeFamilyForUser } from '../../../services/refreshTokens';
import { buildSessionPayload } from '../../../services/sessionPayload';
import type { RequestContext } from '../../context';

export async function issueLoginResult(
  db: DB,
  userId: string,
  memberId: string,
  orgId: string,
  ip: string | null,
  userAgent: string | null,
) {
  const session = await buildSessionPayload(db, userId, memberId, orgId);
  const issued = await issueRefresh(db, {
    userId,
    orgId,
    memberId,
    ip,
    userAgent,
  });
  const accessToken = await signAccess({
    sub: userId,
    org: session.member.orgId,
    mid: memberId,
    fam: issued.family,
  });

  return {
    tokens: {
      accessToken,
      refreshToken: issued.token,
      accessExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      refreshExpiresAt: issued.expiresAt.toISOString(),
    },
    session,
  };
}

/**
 * The caller is moving its session to another organisation and gets a
 * new refresh chain for it. End the chain it is leaving (AUTH-11,
 * 2026-10-30): before, the old refresh token kept working next to the
 * new one and silently put `lastOrgId` back. The access token names
 * its chain; one signed before that claim existed (at most 15 minutes
 * after this shipped) has nothing to name, and the old chain then
 * simply runs out as before.
 */
export async function endLeftRefreshChain(ctx: RequestContext): Promise<void> {
  const family = ctx.session?.refreshFamily;
  if (!family || !ctx.session) return;
  await revokeFamilyForUser(ctx.db, family, ctx.session.userId);
}
