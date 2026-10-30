/**
 * Claim auto-release timing (M3.20 safety net, see `releaseStaleClaims`
 * in main.ts).
 *
 * A claim used to expire CLAIM_TIMEOUT_MINUTES after the claim moment, so
 * an approver who was still editing the order got released mid-review and
 * their approve then failed as stale. The idle clock now starts at the
 * claimer's last activity: the later of the claim time and the claimer's
 * newest event on that stream (`domain.events.actor_id` is the acting
 * user, so it is matched to the claiming member through `auth.members`).
 */
import { randomUUID } from 'node:crypto';
import { eq, sql, type SQL } from 'drizzle-orm';
import { notifyRealtime, schema as s, type DB } from '@compass/db';

/**
 * A timestamp as raw `tx.execute` returns it. Drizzle's postgres-js
 * driver leaves timestamptz columns as strings on raw queries (only its
 * query builder maps them to Date), so the old `cur.claimed_at.getTime()`
 * threw a TypeError for every candidate and no claim was auto-released.
 */
export type DbTimestamp = Date | string;

export function toDate(value: DbTimestamp): Date {
  return value instanceof Date ? value : new Date(value);
}

/** When the claimer was last seen working on this order / run. */
export function claimLastActiveAt(
  claimedAt: DbTimestamp,
  lastClaimerEventAt: DbTimestamp | null,
): Date {
  const claimed = toDate(claimedAt);
  const lastEvent = lastClaimerEventAt === null ? null : toDate(lastClaimerEventAt);
  return lastEvent && lastEvent.getTime() > claimed.getTime() ? lastEvent : claimed;
}

/**
 * Has the claim sat idle for at least `timeoutMinutes`? `timeoutMinutes
 * <= 0` means the auto-release is disabled and nothing ever expires.
 */
export function isClaimExpired(input: {
  claimedAt: DbTimestamp;
  lastClaimerEventAt: DbTimestamp | null;
  now: Date;
  timeoutMinutes: number;
}): boolean {
  if (input.timeoutMinutes <= 0) return false;
  const lastActive = claimLastActiveAt(input.claimedAt, input.lastClaimerEventAt);
  return lastActive.getTime() < input.now.getTime() - input.timeoutMinutes * 60_000;
}

export type ClaimStream = 'order' | 'run';

/** Fixed table per stream type; never built from caller input. */
const CLAIM_TABLES: Record<ClaimStream, { table: SQL; statusFilter: SQL }> = {
  order: {
    table: sql.raw('read_model.order_sessions_v'),
    statusFilter: sql.raw(`c.status = 'submitted'`),
  },
  run: {
    table: sql.raw('read_model.market_runs_v'),
    statusFilter: sql.raw(`c.status IN ('planned', 'purchasing', 'delivering')`),
  },
};

/**
 * Newest event the claiming member appended to this stream, as a
 * correlated scalar subquery over the claim row aliased `c`.
 */
function lastClaimerEventAtSql(stream: ClaimStream): SQL {
  return sql`(
    SELECT MAX(e.occurred_at)
    FROM domain.events e
    JOIN auth.members m ON m.user_id = e.actor_id
    WHERE e.stream_type = ${stream}
      AND e.stream_id = c.id
      AND m.id = c.claimed_by_member_id
  )`;
}

/**
 * Cheap, lock-free candidate scan: claimed rows whose last claimer
 * activity is older than the timeout. Callers re-check each row under
 * `FOR UPDATE` with `claimRowForUpdateSql` + `isClaimExpired`.
 */
export function staleClaimCandidatesSql(
  stream: ClaimStream,
  timeoutMinutes: number,
  limit = 100,
): SQL {
  const { table, statusFilter } = CLAIM_TABLES[stream];
  return sql`
    SELECT id, org_id, last_seq, claimed_by_member_id, claimed_at, last_claimer_event_at
    FROM (
      SELECT c.id, c.org_id, c.last_seq, c.claimed_by_member_id, c.claimed_at,
        ${lastClaimerEventAtSql(stream)} AS last_claimer_event_at
      FROM ${table} c
      WHERE ${statusFilter}
        AND c.claimed_by_member_id IS NOT NULL
        AND c.claimed_at < NOW() - (${timeoutMinutes}::int * interval '1 minute')
    ) claims
    WHERE GREATEST(claimed_at, last_claimer_event_at)
      < NOW() - (${timeoutMinutes}::int * interval '1 minute')
    ORDER BY GREATEST(claimed_at, last_claimer_event_at)
    LIMIT ${limit}::int
  `;
}

/**
 * Re-read one claim row under a row lock, with the claimer's latest
 * event time. An event the claimer appends after this read would take
 * the same seq as the release, so `events_stream_seq_unique` lets at
 * most one of the two commit.
 */
export function claimRowForUpdateSql(stream: ClaimStream, id: string): SQL {
  const { table } = CLAIM_TABLES[stream];
  return sql`
    SELECT c.last_seq, c.claimed_by_member_id, c.claimed_at, c.status,
      ${lastClaimerEventAtSql(stream)} AS last_claimer_event_at
    FROM ${table} c
    WHERE c.id = ${id}
    FOR UPDATE OF c
  `;
}

/**
 * The seq of the event appended after `lastSeq`.
 *
 * RE-APR-1 (2026-10-30): `last_seq` is a bigint column, and raw
 * `tx.execute` returns it as a STRING, so `cur.last_seq + 1` built
 * "17" + 1 = "171". Every timeout release (and orphan repair) wrote an
 * event with a jumped seq, after which the stream refused all writes.
 */
export function nextSeq(lastSeq: number | string | bigint): number {
  const n = Number(lastSeq);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`invalid last_seq: ${String(lastSeq)}`);
  }
  return n + 1;
}

type LockedClaimRow = {
  last_seq: number | string; // bigint: a string from raw tx.execute
  claimed_by_member_id: string | null;
  claimed_at: DbTimestamp | null;
  status: string;
  last_claimer_event_at: DbTimestamp | null;
};

const CLAIMABLE_STATUSES: Record<ClaimStream, readonly string[]> = {
  order: ['submitted'],
  run: ['planned', 'purchasing', 'delivering'],
};

/**
 * Release one claim, in the caller's transaction, if it is still idle
 * past the timeout once its row is locked. Another tx may have approved,
 * rejected or released it between the candidate scan and now; then this
 * does nothing and returns false.
 *
 * Appends `ClaimReleased` / `RunClaimReleased` with `reason: 'timeout'`
 * and no actor, mirrors the projector on the read model (the timed-out
 * claimer becomes previous_claimer_member_id, so the next reviewer's
 * banner shows "X → Y"), and announces the change to open pages
 * (APR-12/B14). The worker has no realtime hub of its own: the
 * announcement is a Postgres NOTIFY, sent on commit, after the row lock
 * is gone, and not at all if the transaction rolls back.
 */
export async function releaseClaimIfExpired(
  tx: DB,
  stream: ClaimStream,
  claim: { id: string; orgId: string },
  timeoutMinutes: number,
): Promise<boolean> {
  const fresh = (await tx.execute(
    claimRowForUpdateSql(stream, claim.id),
  )) as unknown as LockedClaimRow[];
  const cur = fresh[0];
  if (!cur) return false;
  if (
    !CLAIMABLE_STATUSES[stream].includes(cur.status) ||
    cur.claimed_by_member_id === null ||
    cur.claimed_at === null ||
    !isClaimExpired({
      claimedAt: cur.claimed_at,
      lastClaimerEventAt: cur.last_claimer_event_at,
      now: new Date(),
      timeoutMinutes,
    })
  ) {
    return false;
  }
  const newSeq = nextSeq(cur.last_seq);
  const occurredAt = new Date();
  // (stream_id, seq) is unique, so a racing append makes this insert
  // fail; the caller lets the tx roll back and moves on.
  await tx.insert(s.events).values({
    id: randomUUID(),
    orgId: claim.orgId,
    streamType: stream,
    streamId: claim.id,
    seq: newSeq,
    type: stream === 'order' ? 'ClaimReleased' : 'RunClaimReleased',
    payload: { byMemberId: null, reason: 'timeout' },
    actorId: null,
    occurredAt,
    correlationId: null,
    causationId: null,
    idempotencyKey: null,
  });
  const released = {
    claimedByMemberId: null,
    claimedAt: null,
    previousClaimerMemberId: cur.claimed_by_member_id,
    lastSeq: newSeq,
    updatedAt: occurredAt,
  };
  if (stream === 'order') {
    await tx.update(s.orderSessionsV).set(released).where(eq(s.orderSessionsV.id, claim.id));
    await notifyRealtime(tx, {
      type: 'order.changed',
      orgId: claim.orgId,
      sessionId: claim.id,
      lastSeq: newSeq,
    });
  } else {
    await tx.update(s.marketRunsV).set(released).where(eq(s.marketRunsV.id, claim.id));
    await notifyRealtime(tx, {
      type: 'run.changed',
      orgId: claim.orgId,
      runId: claim.id,
      lastSeq: newSeq,
    });
  }
  return true;
}
