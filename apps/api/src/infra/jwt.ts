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

export async function signRefresh(userId: string, family: string): Promise<string> {
  return await new SignJWT({ sub: userId, family })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(REFRESH_TTL)
    .sign(refreshSecret);
}

export async function verifyRefresh(token: string): Promise<{ sub: string; family: string }> {
  const { payload } = await jwtVerify(token, refreshSecret);
  return { sub: String(payload.sub), family: String(payload.family) };
}
