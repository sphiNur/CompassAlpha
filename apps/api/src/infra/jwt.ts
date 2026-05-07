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
  return payload as unknown as AccessClaims;
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
): Promise<string> {
  return await new SignJWT({ sub: userId, family, jti })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(REFRESH_TTL)
    .sign(refreshSecret);
}

export async function verifyRefresh(
  token: string,
): Promise<{ sub: string; family: string; jti: string | null }> {
  const { payload } = await jwtVerify(token, refreshSecret);
  // jti is optional during the migration window — tokens issued
  // before M1.9 lack it. Treated as legacy by the consume helper.
  return {
    sub: String(payload.sub),
    family: String(payload.family),
    jti: typeof payload.jti === 'string' ? payload.jti : null,
  };
}
