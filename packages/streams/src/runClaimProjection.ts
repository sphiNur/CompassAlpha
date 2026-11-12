/**
 * The run claim on read_model.market_runs_v (C.2, M3.38), projected from
 * `RunClaimed` and `RunClaimReleased`. The API's run projector hands these
 * two events here, and the worker projects its timed-out release with the
 * same code (review ORD-07: it had a copy of the release).
 */
import { eq, sql } from 'drizzle-orm';
import type { DB } from '@compass/db';
import { schema as s } from '@compass/db';
import type { RunEvent } from '@compass/domain/run';

export type RunClaimEvent = Extract<RunEvent, { type: 'RunClaimed' | 'RunClaimReleased' }>;

export async function projectRunClaim(db: DB, e: RunClaimEvent): Promise<void> {
  if (e.type === 'RunClaimed') {
    // The reducer mirrors this exactly: claimer and time. The previous
    // claimer stays, so the next purchaser's banner can still show
    // "X → Y" after the new claim lands (cleared only on a self-release
    // or a terminal state).
    await db
      .update(s.marketRunsV)
      .set({
        claimedByMemberId: e.payload.byMemberId,
        claimedAt: e.occurredAt,
        lastSeq: e.seq,
        updatedAt: new Date(),
      })
      .where(eq(s.marketRunsV.id, e.streamId));
    return;
  }
  // Mirror of the order projection's ClaimReleased: a forced release
  // (override / timeout) keeps the prior claimer in
  // previous_claimer_member_id for the next purchaser's banner; a
  // self-release (manual / pagehide) clears it so the next claim starts
  // fresh. The SET reads claimed_by_member_id from the old row.
  const remembersOverride = e.payload.reason === 'override' || e.payload.reason === 'timeout';
  await db
    .update(s.marketRunsV)
    .set({
      claimedByMemberId: null,
      claimedAt: null,
      previousClaimerMemberId: remembersOverride ? sql`claimed_by_member_id` : null,
      lastSeq: e.seq,
      updatedAt: new Date(),
    })
    .where(eq(s.marketRunsV.id, e.streamId));
}
