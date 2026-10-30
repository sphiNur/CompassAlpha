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
 *   rotateRefresh(jti, family, …)
 *     → SELECT row by id
 *     → if missing or expired: refused
 *     → if consumed: the same successor again within the retry
 *       leeway, otherwise REPLAY DETECTED → revoke entire family
 *     → else: mark this row consumed and insert its successor
 *       (one transaction)
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
 * Graceful migration: tokens issued before this commit had no jti and
 * were exchanged once for a tracked token. Their 30-day lifetime ended
 * in June 2026, so since B12 (2026-10-30) auth.refresh refuses any token
 * without a tracked row.
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DB } from '@compass/db';
import { inSystem, schema as s, withSystemContext } from '@compass/db';
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
  return inSystem(db, 'auth', (tx) => insertRefresh(tx, opts));
}

async function insertRefresh(
  tx: DB,
  opts: IssueOpts,
): Promise<{ token: string; id: string; family: string; expiresAt: Date }> {
  const id = randomUUID();
  const family = opts.family ?? randomUUID();
  // The row's created_at and expires_at are the token's iat and exp, so
  // the same token can be signed again from the row (see rotateRefresh).
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + REFRESH_TTL_MS);
  const token = await signRefresh(opts.userId, family, id, opts.orgId, opts.memberId, {
    issuedAt,
    expiresAt,
  });
  await tx.insert(s.refreshTokens).values({
    id,
    userId: opts.userId,
    tokenHash: hashToken(token),
    family,
    parentId: opts.parentId ?? null,
    ip: opts.ip ?? null,
    userAgent: opts.userAgent ?? null,
    expiresAt,
    createdAt: issuedAt,
  });
  return { token, id, family, expiresAt };
}

/** How long after a rotation the consumed token may be presented again. */
export const ROTATION_RETRY_LEEWAY_MS = 60_000;

interface RotateOpts {
  /** `jti` and `family` claims of the presented (verified) refresh JWT. */
  jti: string;
  family: string;
  userId: string;
  /** Tenant the successor is bound to. */
  orgId?: string;
  memberId?: string;
  ip?: string | null;
  userAgent?: string | null;
}

type RotateOutcome =
  | { kind: 'rotated'; token: string; id: string; family: string; expiresAt: Date }
  | { kind: 'notFound' }
  | { kind: 'replay'; family: string };

/**
 * Exchange a tracked refresh token for its successor in the same family.
 *
 *   - Active row: mark it consumed and insert the successor, in ONE
 *     transaction. A concurrent request carrying the same token blocks
 *     on the row lock, then finds it consumed and the successor already
 *     committed.
 *   - Consumed within ROTATION_RETRY_LEEWAY_MS and its successor still
 *     live: the client never got (or another tab already took) the
 *     successor. Hand back THAT successor, signed again from its row —
 *     never a new one (AUTH-12, 2026-10-30). Before, every retry in the
 *     window minted another live token, so one stolen token could fork
 *     into any number of sessions.
 *   - Anything else that was consumed: replay. The whole family is
 *     revoked (committed on its own, outside the failed transaction) and
 *     `RefreshReplayError` is thrown.
 *   - No row, or the row has expired: `RefreshNotFoundError`. The caller
 *     refuses the token (B12): every refresh token issued since M1.9 has
 *     its row written before it is returned, and rows are only deleted
 *     a week after they expire.
 */
export async function rotateRefresh(
  db: DB,
  opts: RotateOpts,
): Promise<{ token: string; id: string; family: string; expiresAt: Date }> {
  const outcome = await withSystemContext(db, 'auth', async (tx): Promise<RotateOutcome> => {
    const row = await tx.query.refreshTokens.findFirst({
      where: (rt, { eq: eq2 }) => eq2(rt.id, opts.jti),
    });
    if (!row) return { kind: 'notFound' };
    // The JWT is ours, so its family and subject always match the row.
    // If they do not, treat it as forgery.
    if (row.family !== opts.family || row.userId !== opts.userId) {
      return { kind: 'replay', family: row.family };
    }
    let revokedAt = row.revokedAt;
    if (!revokedAt) {
      if (row.expiresAt <= new Date()) return { kind: 'notFound' };
      const consumed = await tx
        .update(s.refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(s.refreshTokens.id, opts.jti), isNull(s.refreshTokens.revokedAt)))
        .returning({ id: s.refreshTokens.id });
      if (consumed.length === 1) {
        const issued = await insertRefresh(tx, {
          userId: opts.userId,
          orgId: opts.orgId,
          memberId: opts.memberId,
          family: row.family,
          parentId: row.id,
          ip: opts.ip,
          userAgent: opts.userAgent,
        });
        return { kind: 'rotated', ...issued };
      }
      // Lost the race to a concurrent request with the same token. Its
      // transaction has committed by now (we waited on the row lock), so
      // its successor is visible below.
      const now = await tx.query.refreshTokens.findFirst({
        where: (rt, { eq: eq2 }) => eq2(rt.id, opts.jti),
      });
      revokedAt = now?.revokedAt ?? null;
      if (!revokedAt) return { kind: 'replay', family: row.family };
    }
    // The client may simply never have received the successor: the
    // rotation committed, the response was lost on a bad connection,
    // and it is retrying with the only token it has. Punishing that as
    // theft signs the user out, and a Mini App that has been open for
    // more than a day cannot sign back in by itself. A sign-out or a
    // detected replay revokes the successor too, and then there is
    // nothing benign left to retry.
    if (Date.now() - revokedAt.getTime() <= ROTATION_RETRY_LEEWAY_MS) {
      const successor = await tx.query.refreshTokens.findFirst({
        where: (rt, { eq: eq2, and: and2, isNull: isNull2 }) =>
          and2(eq2(rt.parentId, row.id), isNull2(rt.revokedAt)),
        orderBy: (rt, { asc }) => [asc(rt.createdAt)],
      });
      if (successor && successor.expiresAt > new Date()) {
        const token = await signRefresh(
          opts.userId,
          successor.family,
          successor.id,
          opts.orgId,
          opts.memberId,
          { issuedAt: successor.createdAt, expiresAt: successor.expiresAt },
        );
        return {
          kind: 'rotated',
          token,
          id: successor.id,
          family: successor.family,
          expiresAt: successor.expiresAt,
        };
      }
    }
    return { kind: 'replay', family: row.family };
  });
  if (outcome.kind === 'notFound') throw new RefreshNotFoundError();
  if (outcome.kind === 'replay') {
    // Replay! Nuke the entire family — any descendant token is now
    // suspect. Caller turns this into a 401 + tells the client to
    // re-login.
    await revokeFamily(db, outcome.family);
    throw new RefreshReplayError();
  }
  return {
    token: outcome.token,
    id: outcome.id,
    family: outcome.family,
    expiresAt: outcome.expiresAt,
  };
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
 * End one user's rotation chain (AUTH-11, 2026-10-30): switching
 * organisation starts a new chain for the new tenant, and the chain the
 * caller is leaving must not keep working next to it. Scoped to the user
 * so a family id from someone else's token cannot revoke theirs.
 */
export async function revokeFamilyForUser(db: DB, family: string, userId: string): Promise<number> {
  const revoked = await inSystem(db, 'auth', (tx) =>
    tx
      .update(s.refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(s.refreshTokens.family, family),
          eq(s.refreshTokens.userId, userId),
          isNull(s.refreshTokens.revokedAt),
        ),
      )
      .returning({ id: s.refreshTokens.id }),
  );
  return revoked.length;
}

/**
 * Mark every token in a rotation chain as revoked. Called by the
 * replay-detection path; not exported as a primary verb because it's
 * meant to fire from inside `rotateRefresh`, not as a standalone
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
