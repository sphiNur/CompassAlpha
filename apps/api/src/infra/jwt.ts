import { createHmac } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../env';

const accessSecret = new TextEncoder().encode(env.JWT_SECRET);
const refreshSecret = new TextEncoder().encode(env.JWT_REFRESH_SECRET);

const ACCESS_TTL = '15m';
const REFRESH_TTL = '30d';

export interface AccessClaims {
  sub: string; // user id
  org: string; // current org id
  mid: string; // member id
  /**
   * Refresh-token family issued alongside this access token (AUTH-11,
   * 2026-10-30). Lets switchOrganization end the chain the caller is
   * leaving without the client having to send its refresh token. Absent
   * on access tokens signed before this field existed.
   */
  fam?: string;
}

export async function signAccess(claims: AccessClaims): Promise<string> {
  return await new SignJWT(claims as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(ACCESS_TTL)
    .sign(accessSecret);
}

export async function verifyAccess(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, accessSecret);
  // A login token names no audience. The month-export link and the
  // liveness challenge did, signed with this same secret until 2026-11-07;
  // without this check the export link worked as a 5-minute login.
  if (payload.aud !== undefined) throw new Error('not an access token');
  return payload as unknown as AccessClaims;
}

/**
 * The signing key for one kind of short-lived token (the export link, the
 * liveness challenge), derived from JWT_SECRET (2026-11-07). Such a token
 * never verifies as a login token, and a login token never as one of them.
 */
export function purposeKey(purpose: string): Uint8Array {
  return new Uint8Array(
    createHmac('sha256', env.JWT_SECRET).update(`compass-token:${purpose}`).digest(),
  );
}

/**
 * Sign a refresh token. M1.9 (2026-05-07): now carries a `jti` (the
 * refresh_tokens row id) so the server can look up the tracked row
 * on consume — the foundation for revocation, rotation lineage, and
 * replay detection. Older clients with jti-less tokens are still
 * accepted (graceful migration); see services/refreshTokens.ts.
 */
export async function signRefresh(
  userId: string,
  family: string,
  jti: string,
  orgId?: string,
  memberId?: string,
  /**
   * Fixed iat/exp (AUTH-12, 2026-10-30). The token is tracked by its
   * row, which records both; signing again from the row gives the same
   * token, so a retried rotation can hand back the successor it already
   * issued instead of minting a second live one.
   */
  times?: { issuedAt: Date; expiresAt: Date },
): Promise<string> {
  const jwt = new SignJWT({
    sub: userId,
    family,
    jti,
    ...(orgId && memberId ? { org: orgId, mid: memberId } : {}),
  }).setProtectedHeader({ alg: 'HS256' });
  if (times) {
    jwt
      .setIssuedAt(Math.floor(times.issuedAt.getTime() / 1000))
      .setExpirationTime(Math.floor(times.expiresAt.getTime() / 1000));
  } else {
    jwt.setIssuedAt().setExpirationTime(REFRESH_TTL);
  }
  return await jwt.sign(refreshSecret);
}

export async function verifyRefresh(token: string): Promise<{
  sub: string;
  family: string;
  jti: string | null;
  org: string | null;
  mid: string | null;
}> {
  const { payload } = await jwtVerify(token, refreshSecret);
  // jti is optional during the migration window — tokens issued
  // before M1.9 lack it. Treated as legacy by the consume helper.
  return {
    sub: String(payload.sub),
    family: String(payload.family),
    jti: typeof payload.jti === 'string' ? payload.jti : null,
    org: typeof payload.org === 'string' ? payload.org : null,
    mid: typeof payload.mid === 'string' ? payload.mid : null,
  };
}
