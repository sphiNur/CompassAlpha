/**
 * Short-lived tokens are not logins (review 2026-11-07): the month-export
 * link and the liveness challenge were signed with the login secret, and
 * the login check ignored the audience, so the export link worked as the
 * manager's session for five minutes.
 */
import { describe, expect, test } from 'bun:test';
import { SignJWT } from 'jose';
import { env } from '../env';
import { signAccess, verifyAccess } from '../infra/jwt';
import { signExportToken, verifyExportToken } from '../services/attendanceExport';
import { signLivenessToken, verifyLivenessToken } from '../services/face/liveness';

const claims = { sub: 'user-1', org: 'org-1', mid: 'member-1' };

async function refused(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return false;
  } catch {
    return true;
  }
}

describe('token purposes', () => {
  test('a login token is a login', async () => {
    const token = await signAccess(claims);
    expect((await verifyAccess(token)).mid).toBe('member-1');
  });

  test('the export link is not a login, and a login is not an export link', async () => {
    const link = await signExportToken({ ...claims, storeId: 's', month: '2026-11', locale: 'en' });
    expect(await refused(verifyAccess(link))).toBe(true);
    expect((await verifyExportToken(link)).month).toBe('2026-11');
    expect(await refused(verifyExportToken(await signAccess(claims)))).toBe(true);
  });

  test('the liveness challenge is not a login', async () => {
    const { token } = await signLivenessToken({ org: 'org-1', mid: 'm', by: 'm', storeId: 's' });
    expect(await refused(verifyAccess(token))).toBe(true);
    expect(await verifyLivenessToken(token)).not.toBeNull();
    expect(await verifyLivenessToken(await signAccess(claims))).toBeNull();
  });

  test('an export link signed the old way (login secret + audience) is refused', async () => {
    const old = await new SignJWT({ ...claims, storeId: 's', month: '2026-11' })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience('attendance-month-export')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(env.JWT_SECRET));
    expect(await refused(verifyAccess(old))).toBe(true);
  });
});
