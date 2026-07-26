/**
 * Tests for the refresh-token tracking layer (M1.9, 2026-05-07).
 *
 * Two slices:
 *
 *   1. PURE — jwt.ts signRefresh/verifyRefresh round-trip including the
 *      new `jti` claim. Runs anywhere; no DB.
 *
 *   2. PG-GATED — services/refreshTokens.ts: issue → consume → replay
 *      detection → revokeAllForUser. These insert into auth.users
 *      (FK requirement) and auth.refresh_tokens. Skipped when
 *      DATABASE_URL is unset OR SKIP_PG_TESTS=1, mirroring the
 *      store-scoped-admin test bootstrap.
 *
 * Why the test exists: pre-M1.9 the refresh path was stateless JWT
 * with no DB tracking, so signOut was a no-op and replay was
 * undetectable. The audit explicitly called this out as M2 work; we
 * pulled it forward and these tests pin the security guarantees so a
 * "let's just simplify this back" PR fails the suite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { signRefresh, verifyRefresh } from '../infra/jwt';

// ---------- bootstrap .env so DATABASE_URL + JWT_*_SECRET are on the env

(function loadEnv() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate) && existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
      for (const raw of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const idx = line.indexOf('=');
        if (idx < 0) continue;
        const key = line.slice(0, idx).trim();
        const val = line
          .slice(idx + 1)
          .trim()
          .replace(/^"(.*)"$/, '$1');
        if (!(key in process.env)) process.env[key] = val;
      }
      return;
    }
    dir = resolve(dir, '..');
  }
})();

// JWT secrets must exist for the pure tests to run too. Provide
// defaults so a `bun test` without .env still works for the unit
// half (the service half needs DATABASE_URL anyway).
process.env.JWT_SECRET ??= 'test-access-secret-aaaaaaaaaaaaaaaaaaaa';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-aaaaaaaaaaaaaaaaaa';

const SHOULD_RUN_PG = !!process.env.DATABASE_URL && process.env.SKIP_PG_TESTS !== '1';

// ============ PURE: jwt.ts round-trip ============

describe('jwt: signRefresh / verifyRefresh', () => {
  test('round-trips userId, family, and jti', async () => {
    const userId = '11111111-1111-1111-1111-111111111111';
    const family = '22222222-2222-2222-2222-222222222222';
    const jti = '33333333-3333-3333-3333-333333333333';
    const token = await signRefresh(userId, family, jti);
    expect(typeof token).toBe('string');
    expect(token.split('.').length).toBe(3); // header.payload.sig
    const claims = await verifyRefresh(token);
    expect(claims.sub).toBe(userId);
    expect(claims.family).toBe(family);
    expect(claims.jti).toBe(jti);
  });

  test('verifyRefresh returns jti=null for legacy jti-less tokens', async () => {
    // Forge a refresh token the OLD way (no jti). We construct it via
    // jose directly to mirror the pre-M1.9 codepath.
    const { SignJWT } = await import('jose');
    const secret = new TextEncoder().encode(process.env.JWT_REFRESH_SECRET!);
    const userId = '44444444-4444-4444-4444-444444444444';
    const family = '55555555-5555-5555-5555-555555555555';
    const token = await new SignJWT({ sub: userId, family })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('30d')
      .sign(secret);
    const claims = await verifyRefresh(token);
    expect(claims.sub).toBe(userId);
    expect(claims.family).toBe(family);
    expect(claims.jti).toBeNull();
  });

  test('rejects token signed with a different secret', async () => {
    const { SignJWT } = await import('jose');
    const wrongSecret = new TextEncoder().encode('wrong-secret-aaaaaaaaaaaaaaaaaaaaaaaaa');
    const token = await new SignJWT({ sub: 'u', family: 'f', jti: 'j' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('30d')
      .sign(wrongSecret);
    await expect(verifyRefresh(token)).rejects.toThrow();
  });
});

// ============ PG-GATED: refreshTokens service ============

const pgDescribe = SHOULD_RUN_PG ? describe : describe.skip;

pgDescribe('refreshTokens service (PG-gated)', () => {
  // Lazy-import so the file stays load-able without a DB during the
  // pure half above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let svc: typeof import('../services/refreshTokens');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  let s: typeof import('@compass/db').schema;
  let closeTestDb: typeof import('@compass/db').closeDb;
  let testUserId: string;

  beforeAll(async () => {
    if (!SHOULD_RUN_PG) return;
    svc = await import('../services/refreshTokens');
    const dbMod = await import('@compass/db');
    s = dbMod.schema;
    closeTestDb = dbMod.closeDb;
    db = dbMod.getDb();
    // Insert a test user to satisfy refresh_tokens.user_id FK.
    const tgUserId = BigInt(Date.now());
    const [u] = await db
      .insert(s.users)
      .values({
        tgUserId,
        displayName: 'Refresh-test user',
        locale: 'en',
      })
      .returning();
    testUserId = u.id;
  });

  afterAll(async () => {
    if (!SHOULD_RUN_PG) return;
    try {
      if (testUserId) {
        // CASCADE on user_id will sweep refresh_tokens.
        await db.delete(s.users).where(eq(s.users.id, testUserId));
      }
    } finally {
      await closeTestDb?.();
    }
  });

  test('issueRefresh inserts a tracked row and returns matching jti', async () => {
    const out = await svc.issueRefresh(db, { userId: testUserId });
    expect(out.token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(out.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.family).toMatch(/^[0-9a-f-]{36}$/);
    const row = await db.query.refreshTokens.findFirst({
      where: eq(s.refreshTokens.id, out.id),
    });
    expect(row).toBeTruthy();
    expect(row.userId).toBe(testUserId);
    expect(row.family).toBe(out.family);
    expect(row.parentId).toBeNull();
    expect(row.revokedAt).toBeNull();
    // The JWT's jti claim must equal the row id.
    const claims = await verifyRefresh(out.token);
    expect(claims.jti).toBe(out.id);
  });

  test('consumeRefresh marks revoked and returns userId', async () => {
    const issued = await svc.issueRefresh(db, { userId: testUserId });
    const result = await svc.consumeRefresh(db, issued.id, issued.family);
    expect(result.userId).toBe(testUserId);
    const row = await db.query.refreshTokens.findFirst({
      where: eq(s.refreshTokens.id, issued.id),
    });
    expect(row.revokedAt).not.toBeNull();
  });

  test('consumeRefresh on already-revoked row throws REPLAY and nukes family', async () => {
    const root = await svc.issueRefresh(db, { userId: testUserId });
    // Chain a child token in the same family. After we replay the
    // parent, the child must also be revoked.
    const child = await svc.issueRefresh(db, {
      userId: testUserId,
      family: root.family,
      parentId: root.id,
    });
    // Consume parent twice. First succeeds (marks revoked); second
    // hits the replay path.
    await svc.consumeRefresh(db, root.id, root.family);
    let replayErr: unknown = null;
    try {
      await svc.consumeRefresh(db, root.id, root.family);
    } catch (err) {
      replayErr = err;
    }
    expect(replayErr).toBeTruthy();
    expect((replayErr as Error).message).toMatch(/replay/i);
    // The replay path revokes ALL family members. Verify the child is
    // now also revoked even though we never directly touched it.
    const childRow = await db.query.refreshTokens.findFirst({
      where: eq(s.refreshTokens.id, child.id),
    });
    expect(childRow.revokedAt).not.toBeNull();
  });

  test('consumeRefresh throws NOT_FOUND for unknown jti', async () => {
    const fakeJti = '00000000-0000-0000-0000-000000000000';
    const fakeFamily = '00000000-0000-0000-0000-000000000001';
    await expect(
      svc.consumeRefresh(db, fakeJti, fakeFamily),
    ).rejects.toThrow(/not tracked|expired/);
  });

  test('consumeRefresh throws REPLAY when family does not match the row', async () => {
    // Forgery: someone has the jti right but signed the token with a
    // different family value than the DB row claims. We treat this as
    // a replay to be safe (revokes the legitimate family).
    const issued = await svc.issueRefresh(db, { userId: testUserId });
    const wrongFamily = '99999999-9999-9999-9999-999999999999';
    let replayErr: unknown = null;
    try {
      await svc.consumeRefresh(db, issued.id, wrongFamily);
    } catch (err) {
      replayErr = err;
    }
    expect(replayErr).toBeTruthy();
    expect((replayErr as Error).message).toMatch(/replay/i);
  });

  test('revokeAllForUser revokes every active token, leaves already-revoked alone', async () => {
    // Three fresh tokens. Pre-revoke one to verify we don't double-update.
    const t1 = await svc.issueRefresh(db, { userId: testUserId });
    const t2 = await svc.issueRefresh(db, { userId: testUserId });
    const t3 = await svc.issueRefresh(db, { userId: testUserId });
    await svc.consumeRefresh(db, t2.id, t2.family);
    const t2RevokedFirst = (
      await db.query.refreshTokens.findFirst({
        where: eq(s.refreshTokens.id, t2.id),
      })
    ).revokedAt as Date;
    expect(t2RevokedFirst).not.toBeNull();
    await svc.revokeAllForUser(db, testUserId);
    for (const id of [t1.id, t2.id, t3.id]) {
      const row = await db.query.refreshTokens.findFirst({
        where: eq(s.refreshTokens.id, id),
      });
      expect(row.revokedAt).not.toBeNull();
    }
    // t2's revokedAt should NOT have been overwritten — the WHERE
    // clause includes `revoked_at IS NULL` so the second pass skips it.
    const t2RowAfter = await db.query.refreshTokens.findFirst({
      where: eq(s.refreshTokens.id, t2.id),
    });
    expect((t2RowAfter.revokedAt as Date).getTime()).toBe(t2RevokedFirst.getTime());
  });
});
