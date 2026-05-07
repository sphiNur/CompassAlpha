/**
 * Refresh-token tracking layer (M1.9 hardening, 2026-05-07).
 *
 * Pre-M1.9 the auth router issued refresh tokens as stateless JWTs
 * with no DB tracking. That meant:
 *   - signOut was a no-op (the token kept working until 30d expiry).
 *   - A stolen refresh token could be replayed indefinitely until
 *     the JWT secret rotated.
 *   - There was no way to invalidate a single device.
 *
 * This service writes a `auth.refresh_tokens` row per token issued
 * and gates `consume` on its state. The flow:
 *
 *   issueRefresh()
 *     → INSERT row with id (= JWT `jti`), family, parentId, expiresAt
 *     → return JWT signed with `jti`
 *
 *   consumeRefresh(jti, family)
 *     → SELECT row by id
 *     → if missing or revoked: REPLAY DETECTED → revoke entire family
 *     → else: mark this row revoked (next-call replay protection)
 *     → return ok
 *
 *   revokeAllForUser(userId)
 *     → UPDATE all of user's tokens to revoked
 *
 * The replay-detection check is the security bit. If an old (already-
 * rotated) refresh token shows up, we know either the legitimate
 * user is using a stale device OR an attacker stole the token.
 * Either way the safe response is to nuke the family — every
 * descendant token of the suspected-stolen one — and force fresh
 * login. Defenders accept the false-positive for stale-device users
 * (cost: one re-login) to close the attacker path entirely.
 *
 * Graceful migration: tokens issued before this commit have no jti.
 * The auth.refresh procedure handles those by skipping the consume
 * step + issuing a fresh tracked token. After 30d of refresh-TTL,
 * all sessions are tracked.
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DB } from '@compass/db';
import { schema as s } from '@compass/db';
import { signRefresh } from '../infra/jwt';

export class RefreshReplayError extends Error {
  constructor() {
    super('refresh token replay detected');
    this.name = 'RefreshReplayError';
  }
}

export class RefreshNotFoundError extends Error {
  constructor() {
    super('refresh token not tracked or expired');
    this.name = 'RefreshNotFoundError';
  }
}

const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  // `tokenHash` column is notNull. We don't currently look up by hash
  // (we look up by `id` aka jti), but storing the hash is cheap and
  // gives us a way to revoke by raw token string in the future
  // without trusting the JWT signature first.
  return createHash('sha256').update(token).digest('hex');
}

interface IssueOpts {
  userId: string;
  /** When this is a rotation, pass the consumed token's family + id. */
  family?: string;
  parentId?: string;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Issue a new refresh token AND insert the tracking row in one step.
 * Returns the JWT string + the row id (for callers that want to chain
 * a follow-up rotation).
 */
export async function issueRefresh(
  db: DB,
  opts: IssueOpts,
): Promise<{ token: string; id: string; family: string; expiresAt: Date }> {
  const id = randomUUID();
  const family = opts.family ?? randomUUID();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
  const token = await signRefresh(opts.userId, family, id);
  await db.insert(s.refreshTokens).values({
    id,
    userId: opts.userId,
    tokenHash: hashToken(token),
    family,
    parentId: opts.parentId ?? null,
    ip: opts.ip ?? null,
    userAgent: opts.userAgent ?? null,
    expiresAt,
  });
  return { token, id, family, expiresAt };
}

/**
 * Consume a refresh token: validate it's tracked + active, then mark
 * it revoked. Returns the row's userId on success. Throws
 * `RefreshReplayError` if the row is already revoked (suggesting the
 * token was rotated and someone is replaying the old one) — caller
 * should propagate as 401 + invalidate the entire family.
 *
 * Throws `RefreshNotFoundError` if the row was never tracked (e.g.
 * pre-M1.9 jti-less token, or DB drift). Caller decides whether to
 * grandfather or reject; auth.refresh grandfathers once.
 */
export async function consumeRefresh(
  db: DB,
  jti: string,
  family: string,
): Promise<{ userId: string }> {
  const row = await db.query.refreshTokens.findFirst({
    where: (rt, { eq: eq2 }) => eq2(rt.id, jti),
  });
  if (!row) throw new RefreshNotFoundError();
  // Sanity: the JWT-claimed family must match the DB row's family.
  // If they diverge, the JWT was signed with a different family value
  // than the row claims — should never happen in normal flow; treat
  // as forgery.
  if (row.family !== family) {
    await revokeFamily(db, row.family);
    throw new RefreshReplayError();
  }
  if (row.revokedAt) {
    // Replay! Nuke the entire family — any descendant token is now
    // suspect. Caller turns this into a 401 + tells the client to
    // re-login.
    await revokeFamily(db, row.family);
    throw new RefreshReplayError();
  }
  if (row.expiresAt <= new Date()) {
    throw new RefreshNotFoundError();
  }
  // Mark consumed. Atomic-ish: another concurrent refresh request on
  // the same row would race here; the second to flip `revokedAt`
  // would see the first's update on read and throw replay. Postgres
  // serializes UPDATEs on the same row.
  await db
    .update(s.refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(s.refreshTokens.id, jti), isNull(s.refreshTokens.revokedAt)));
  return { userId: row.userId };
}

/**
 * Revoke all refresh tokens for a user. Used by `auth.signOut` —
 * conservative "sign out everywhere" semantics. If we ever want
 * per-device sign-out, the client passes the refresh token and we
 * revoke just that family.
 */
export async function revokeAllForUser(db: DB, userId: string): Promise<number> {
  const result = await db
    .update(s.refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(s.refreshTokens.userId, userId), isNull(s.refreshTokens.revokedAt)));
  // drizzle-postgres returns rowCount on the underlying query result;
  // shape varies by adapter. Fall back to 0 if we can't read it.
  return (result as unknown as { rowCount?: number }).rowCount ?? 0;
}

/**
 * Mark every token in a rotation chain as revoked. Called by the
 * replay-detection path; not exported as a primary verb because it's
 * meant to fire from inside `consumeRefresh`, not as a standalone
 * action.
 */
async function revokeFamily(db: DB, family: string): Promise<void> {
  await db
    .update(s.refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(s.refreshTokens.family, family), isNull(s.refreshTokens.revokedAt)));
}

/**
 * GC helper for a future cron — drop fully-expired rows beyond a
 * grace period. Not wired today; the table grows ~5 rows/user/month
 * which is fine for a single-chain launch. Wire when row count
 * starts mattering for query plans.
 */
export async function purgeExpiredRefreshTokens(
  db: DB,
  graceDays = 7,
): Promise<number> {
  const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000);
  const result = await db
    .delete(s.refreshTokens)
    .where(sql`${s.refreshTokens.expiresAt} < ${cutoff}`);
  return (result as unknown as { rowCount?: number }).rowCount ?? 0;
}
