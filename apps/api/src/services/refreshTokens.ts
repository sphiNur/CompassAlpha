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
import { inSystem, schema as s } from '@compass/db';
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
  /** Session tenant this refresh chain belongs to. */
  orgId?: string;
  memberId?: string;
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
  const token = await signRefresh(opts.userId, family, id, opts.orgId, opts.memberId);
  await inSystem(db, 'auth', (tx) =>
    tx.insert(s.refreshTokens).values({
      id,
      userId: opts.userId,
      tokenHash: hashToken(token),
      family,
      parentId: opts.parentId ?? null,
      ip: opts.ip ?? null,
      userAgent: opts.userAgent ?? null,
      expiresAt,
    }),
  );
  return { token, id, family, expiresAt };
}

/** How long after a rotation the consumed token may be presented again. */
export const ROTATION_RETRY_LEEWAY_MS = 60_000;

/**
 * Is a consumed token being presented again because its successor never
 * arrived? True only shortly after the rotation, and only while that
 * successor is still live: a sign-out or a detected replay revokes the
 * successor too, and then there is nothing benign left to retry.
 */
async function isRetryOfLostRotation(db: DB, jti: string, revokedAt: Date): Promise<boolean> {
  if (Date.now() - revokedAt.getTime() > ROTATION_RETRY_LEEWAY_MS) return false;
  const successor = await inSystem(db, 'auth', (tx) =>
    tx.query.refreshTokens.findFirst({
      where: (rt, { eq: eq2, and: and2, isNull: isNull2 }) =>
        and2(eq2(rt.parentId, jti), isNull2(rt.revokedAt)),
    }),
  );
  return successor !== undefined;
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
  const row = await inSystem(db, 'auth', (tx) =>
    tx.query.refreshTokens.findFirst({
      where: (rt, { eq: eq2 }) => eq2(rt.id, jti),
    }),
  );
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
    // The client may simply never have received the successor: the
    // rotation committed, the response was lost on a bad connection,
    // and it is retrying with the only token it has. Punishing that as
    // theft signs the user out, and a Mini App that has been open for
    // more than a day cannot sign back in by itself.
    if (await isRetryOfLostRotation(db, row.id, row.revokedAt)) {
      return { userId: row.userId };
    }
    // Replay! Nuke the entire family — any descendant token is now
    // suspect. Caller turns this into a 401 + tells the client to
    // re-login.
    await revokeFamily(db, row.family);
    throw new RefreshReplayError();
  }
  if (row.expiresAt <= new Date()) {
    throw new RefreshNotFoundError();
  }
  // Mark consumed. The read above is not a lock: two requests carrying
  // the same token can both get this far. The conditional UPDATE lets
  // exactly one of them flip the row; the other sees no row come back
  // and is a replay like any other.
  const consumed = await inSystem(db, 'auth', (tx) =>
    tx
      .update(s.refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(s.refreshTokens.id, jti), isNull(s.refreshTokens.revokedAt)))
      .returning({ id: s.refreshTokens.id }),
  );
  if (consumed.length === 0) {
    await revokeFamily(db, row.family);
    throw new RefreshReplayError();
  }
  return { userId: row.userId };
}

/**
 * Revoke all refresh tokens for a user. Used by `auth.signOut` —
 * conservative "sign out everywhere" semantics. If we ever want
 * per-device sign-out, the client passes the refresh token and we
 * revoke just that family.
 */
export async function revokeAllForUser(db: DB, userId: string): Promise<number> {
  // AUTH-10 (2026-10-30): read the count from RETURNING. postgres-js has
  // no `rowCount`, so this always reported 0 although tokens were revoked.
  const revoked = await inSystem(db, 'auth', (tx) =>
    tx
      .update(s.refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(s.refreshTokens.userId, userId), isNull(s.refreshTokens.revokedAt)))
      .returning({ id: s.refreshTokens.id }),
  );
  return revoked.length;
}

/**
 * Mark every token in a rotation chain as revoked. Called by the
 * replay-detection path; not exported as a primary verb because it's
 * meant to fire from inside `consumeRefresh`, not as a standalone
 * action.
 */
async function revokeFamily(db: DB, family: string): Promise<void> {
  await inSystem(db, 'auth', (tx) =>
    tx
      .update(s.refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(s.refreshTokens.family, family), isNull(s.refreshTokens.revokedAt))),
  );
}

/**
 * GC helper for a future cron — drop fully-expired rows beyond a
 * grace period. Not wired today; the table grows ~5 rows/user/month
 * which is fine for a single-chain launch. Wire when row count
 * starts mattering for query plans.
 */
export async function purgeExpiredRefreshTokens(db: DB, graceDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000);
  const result = await inSystem(db, 'auth', (tx) =>
    tx.delete(s.refreshTokens).where(sql`${s.refreshTokens.expiresAt} < ${cutoff}`),
  );
  return (result as unknown as { rowCount?: number }).rowCount ?? 0;
}
