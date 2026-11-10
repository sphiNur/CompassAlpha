/**
 * Short-lived tokens are not logins (review 2026-11-07): the month-export
 * link and the liveness challenge were signed with the login secret, and
 * the login check ignored the audience, so the export link worked as the
 * manager's session for five minutes.
 *
 * Review COREAPI-20: verifying names the algorithm, login and refresh
 * tokens say their kind in `typ`, and the two keys must differ.
 *
 * Each refusal is checked for its reason (review TEST2-16): a test that
 * took any error as the refusal also passed on a missing env or a typo.
 */
import { describe, expect, test } from 'bun:test';
import { decodeProtectedHeader, errors, SignJWT } from 'jose';
import { assertDistinctTokenKeys, env } from '../env';
import { signAccess, signRefresh, verifyAccess, verifyRefresh } from '../infra/jwt';
import { signExportToken, verifyExportToken } from '../services/attendanceExport';
import { signLivenessToken, verifyLivenessToken } from '../services/face/liveness';

const claims = { sub: 'user-1', org: 'org-1', mid: 'member-1' };
const accessKey = new TextEncoder().encode(env.JWT_SECRET);
const refreshKey = new TextEncoder().encode(env.JWT_REFRESH_SECRET);

/** A token signed by hand: the algorithm and `typ` are the test's to choose. */
function signed(
  key: Uint8Array,
  header: { alg: string; typ?: string },
  payload: Record<string, unknown> = claims,
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader(header)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}

describe('token purposes', () => {
  test('a login token is a login', async () => {
    const token = await signAccess(claims);
    expect((await verifyAccess(token)).mid).toBe('member-1');
  });

  test('the export link is not a login, and a login is not an export link', async () => {
    const link = await signExportToken({ ...claims, storeId: 's', month: '2026-11', locale: 'en' });
    // Each has its own key, so the signature is what fails.
    await expect(verifyAccess(link)).rejects.toBeInstanceOf(errors.JWSSignatureVerificationFailed);
    expect((await verifyExportToken(link)).month).toBe('2026-11');
    await expect(verifyExportToken(await signAccess(claims))).rejects.toBeInstanceOf(
      errors.JWSSignatureVerificationFailed,
    );
  });

  test('the liveness challenge is not a login', async () => {
    const { token } = await signLivenessToken({ org: 'org-1', mid: 'm', by: 'm', storeId: 's' });
    await expect(verifyAccess(token)).rejects.toBeInstanceOf(errors.JWSSignatureVerificationFailed);
    expect(await verifyLivenessToken(token)).not.toBeNull();
    expect(await verifyLivenessToken(await signAccess(claims))).toBeNull();
  });

  test('an export link signed the old way (login secret + audience) is refused', async () => {
    const old = await new SignJWT({ ...claims, storeId: 's', month: '2026-11' })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience('attendance-month-export')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(accessKey);
    // The signature holds; the audience gives it away.
    await expect(verifyAccess(old)).rejects.toThrow('not an access token');
  });
});

describe('login and refresh tokens (review COREAPI-20)', () => {
  test('each says its kind', async () => {
    expect(decodeProtectedHeader(await signAccess(claims))).toEqual({
      alg: 'HS256',
      typ: 'access+jwt',
    });
    const refresh = await signRefresh('user-1', 'family-1', 'jti-1');
    expect(decodeProtectedHeader(refresh)).toEqual({ alg: 'HS256', typ: 'refresh+jwt' });
    expect((await verifyRefresh(refresh)).jti).toBe('jti-1');
  });

  test('a token that names another algorithm is refused, even under the right key', async () => {
    const access = await signed(accessKey, { alg: 'HS512', typ: 'access+jwt' });
    await expect(verifyAccess(access)).rejects.toBeInstanceOf(errors.JOSEAlgNotAllowed);
    const refresh = await signed(
      refreshKey,
      { alg: 'HS384', typ: 'refresh+jwt' },
      { sub: 'user-1', family: 'f', jti: 'j' },
    );
    await expect(verifyRefresh(refresh)).rejects.toBeInstanceOf(errors.JOSEAlgNotAllowed);
  });

  test('a token of the other kind is refused, even under the right key', async () => {
    const access = await signed(accessKey, { alg: 'HS256', typ: 'refresh+jwt' });
    await expect(verifyAccess(access)).rejects.toThrow('wrong token kind: refresh+jwt');
    const refresh = await signed(
      refreshKey,
      { alg: 'HS256', typ: 'access+jwt' },
      { sub: 'user-1', family: 'f', jti: 'j' },
    );
    await expect(verifyRefresh(refresh)).rejects.toThrow('wrong token kind: access+jwt');
  });

  test('a token signed before `typ` existed still verifies', async () => {
    const access = await signed(accessKey, { alg: 'HS256' });
    expect((await verifyAccess(access)).mid).toBe('member-1');
    const refresh = await signed(
      refreshKey,
      { alg: 'HS256' },
      { sub: 'user-1', family: 'f', jti: 'j' },
    );
    expect((await verifyRefresh(refresh)).family).toBe('f');
  });

  test('the api refuses one value for both keys', () => {
    const key = 'k'.repeat(40);
    expect(() => assertDistinctTokenKeys({ JWT_SECRET: key, JWT_REFRESH_SECRET: key })).toThrow(
      'JWT_REFRESH_SECRET must differ from JWT_SECRET',
    );
    expect(() =>
      assertDistinctTokenKeys({ JWT_SECRET: key, JWT_REFRESH_SECRET: `${key}x` }),
    ).not.toThrow();
  });
});
