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

  test('carries the tenant the refresh chain belongs to', async () => {
    const userId = '66666666-6666-6666-6666-666666666666';
    const family = '77777777-7777-7777-7777-777777777777';
    const jti = '88888888-8888-8888-8888-888888888888';
    const orgId = '99999999-9999-9999-9999-999999999999';
    const memberId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const claims = await verifyRefresh(await signRefresh(userId, family, jti, orgId, memberId));
    expect(claims.org).toBe(orgId);
    expect(claims.mid).toBe(memberId);
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
    expect(claims.org).toBeNull();
    expect(claims.mid).toBeNull();
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
    db = dbMod.getDb(undefined, { system: 'maintenance' });
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

  const rotate = (t: { id: string; family: string }, family = t.family) =>
    svc.rotateRefresh(db, { jti: t.id, family, userId: testUserId });
  const rowOf = (id: string) =>
    db.query.refreshTokens.findFirst({ where: eq(s.refreshTokens.id, id) });

  test('rotateRefresh consumes the token and issues its successor in the same family', async () => {
    const issued = await svc.issueRefresh(db, { userId: testUserId });
    const next = await rotate(issued);
    expect(next.family).toBe(issued.family);
    expect(next.id).not.toBe(issued.id);
    expect((await rowOf(issued.id)).revokedAt).not.toBeNull();
    const child = await rowOf(next.id);
    expect(child.parentId).toBe(issued.id);
    expect(child.revokedAt).toBeNull();
    expect((await verifyRefresh(next.token)).jti).toBe(next.id);
  });

  test('concurrent rotations of one token all get the same successor (AUTH-12)', async () => {
    const issued = await svc.issueRefresh(db, { userId: testUserId });
    // Open the pool first. On cold connections the first caller finishes
    // before the rest have connected and the race never happens.
    await Promise.all(
      Array.from({ length: 8 }, () =>
        db.query.users.findFirst({ where: eq(s.users.id, testUserId) }),
      ),
    );
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => rotate(issued)));
    const ok = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof rotate>>> =>
        r.status === 'fulfilled',
    );
    expect(ok.length).toBe(8);
    expect(new Set(ok.map((r) => r.value.id)).size).toBe(1);
    expect(new Set(ok.map((r) => r.value.token)).size).toBe(1);
    const children = await db.query.refreshTokens.findMany({
      where: eq(s.refreshTokens.parentId, issued.id),
    });
    expect(children.length).toBe(1);
  });

  test('a retry after a lost response gets the same successor back, not a new one', async () => {
    const root = await svc.issueRefresh(db, { userId: testUserId });
    const first = await rotate(root);
    const retry = await rotate(root);
    const again = await rotate(root);
    expect(retry.id).toBe(first.id);
    expect(retry.token).toBe(first.token);
    expect(again.token).toBe(first.token);
    // The re-signed token is byte-identical to the stored one.
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(retry.token).digest('hex')).toBe(
      (await rowOf(first.id)).tokenHash,
    );
    expect(
      (await db.query.refreshTokens.findMany({ where: eq(s.refreshTokens.parentId, root.id) }))
        .length,
    ).toBe(1);
    // One chain: once the successor moves on, the old token is a replay.
    await rotate(first);
    await expect(rotate(root)).rejects.toBeInstanceOf(svc.RefreshReplayError);
  });

  test('a signed-out token is not revived by the retry leeway', async () => {
    const root = await svc.issueRefresh(db, { userId: testUserId });
    await rotate(root);
    await svc.revokeAllForUser(db, testUserId);
    await expect(rotate(root)).rejects.toBeInstanceOf(svc.RefreshReplayError);
  });

  test('a consumed token after the leeway is a replay and nukes the family', async () => {
    const root = await svc.issueRefresh(db, { userId: testUserId });
    const child = await rotate(root);
    await db
      .update(s.refreshTokens)
      .set({ revokedAt: new Date(Date.now() - svc.ROTATION_RETRY_LEEWAY_MS - 1_000) })
      .where(eq(s.refreshTokens.id, root.id));
    let replayErr: unknown = null;
    try {
      await rotate(root);
    } catch (err) {
      replayErr = err;
    }
    expect(replayErr).toBeTruthy();
    expect((replayErr as Error).message).toMatch(/replay/i);
    // The replay path revokes ALL family members. Verify the child is
    // now also revoked even though we never directly touched it.
    expect((await rowOf(child.id)).revokedAt).not.toBeNull();
  });

  test('rotateRefresh throws NOT_FOUND for unknown jti', async () => {
    const fakeJti = '00000000-0000-0000-0000-000000000000';
    const fakeFamily = '00000000-0000-0000-0000-000000000001';
    await expect(rotate({ id: fakeJti, family: fakeFamily })).rejects.toBeInstanceOf(
      svc.RefreshNotFoundError,
    );
  });

  test('rotateRefresh throws NOT_FOUND for an expired row', async () => {
    const issued = await svc.issueRefresh(db, { userId: testUserId });
    await db
      .update(s.refreshTokens)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(s.refreshTokens.id, issued.id));
    await expect(rotate(issued)).rejects.toBeInstanceOf(svc.RefreshNotFoundError);
  });

  test('rotateRefresh throws REPLAY when family does not match the row', async () => {
    // Forgery: someone has the jti right but signed the token with a
    // different family value than the DB row claims. We treat this as
    // a replay to be safe (revokes the legitimate family).
    const issued = await svc.issueRefresh(db, { userId: testUserId });
    const wrongFamily = '99999999-9999-9999-9999-999999999999';
    await expect(rotate(issued, wrongFamily)).rejects.toBeInstanceOf(svc.RefreshReplayError);
    expect((await rowOf(issued.id)).revokedAt).not.toBeNull();
  });

  test('revokeFamilyForUser ends one chain of that user only', async () => {
    const a = await svc.issueRefresh(db, { userId: testUserId });
    const b = await svc.issueRefresh(db, { userId: testUserId });
    const ended = await svc.revokeFamilyForUser(db, a.family, testUserId);
    expect(ended).toBe(1);
    expect((await rowOf(a.id)).revokedAt).not.toBeNull();
    expect((await rowOf(b.id)).revokedAt).toBeNull();
    // Someone else's id cannot end it.
    expect(
      await svc.revokeFamilyForUser(db, b.family, '00000000-0000-0000-0000-000000000009'),
    ).toBe(0);
    expect((await rowOf(b.id)).revokedAt).toBeNull();
  });

  test('revokeAllForUser revokes every active token, leaves already-revoked alone', async () => {
    // Three fresh tokens. Pre-revoke one to verify we don't double-update.
    const t1 = await svc.issueRefresh(db, { userId: testUserId });
    const t2 = await svc.issueRefresh(db, { userId: testUserId });
    const t3 = await svc.issueRefresh(db, { userId: testUserId });
    await rotate(t2);
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
