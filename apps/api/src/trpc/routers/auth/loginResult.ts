/**
 * What every sign-in returns (a login token, a refresh token and the
 * session), and ending the refresh chain a session moves away from.
 */
import type { DB } from '@compass/db';
import type { Session } from '@compass/contracts';
import { accessTokenExpiry, signAccess } from '../../../infra/jwt';
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
  return loginResultFor(userId, memberId, session, issued);
}

/**
 * What a sign-in or a refresh answers: a login token on the refresh chain
 * `issued` belongs to, that refresh token, when each runs out, and the
 * session.
 */
export async function loginResultFor(
  userId: string,
  memberId: string,
  session: Session,
  issued: { token: string; family: string; expiresAt: Date },
) {
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
      accessExpiresAt: accessTokenExpiry().toISOString(),
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
