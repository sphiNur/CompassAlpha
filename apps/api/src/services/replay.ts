/**
 * The replay behind scripts/reproject.ts, shared with the rebuild parity
 * test (src/__tests__/rebuild-parity.test.ts), which checks that replaying
 * the log gives the read model the live projection wrote.
 */
import { sql } from 'drizzle-orm';
import { getDb, type DB } from '@compass/db';

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

/**
 * Replay every event of one stream type in the order it happened ACROSS
 * streams, one event at a time.
 *
 * Replaying stream by stream cannot work: the read model carries
 * invariants that span streams ("one active run per org", "one draft
 * per member, store and day", "(org, date, index) is unique"), and a
 * history is only valid in the order it was written. A run that was
 * finished, then reopened while the next day's run was already planned,
 * is two `planned` rows at once if its stream is replayed in one go; the
 * projector's conflict-tolerant insert then drops the run row and the
 * item rows fail their foreign key.
 *
 * There is no global sequence on domain.events, so `occurred_at` is the
 * clock. A stream's own order always wins: each event sorts by the
 * latest `occurred_at` seen so far in its stream, which can never place
 * seq N+1 ahead of seq N even if a clock stepped backwards.
 */
export async function replay<E extends { streamId: string }, S>(
  tx: Tx,
  cfg: {
    streamType: 'run' | 'order';
    empty: (streamId: string) => S;
    apply: (state: S, event: E) => S;
    project: (db: DB, orgId: string, events: E[]) => Promise<void>;
    /** Only this organisation's streams (the rebuild parity test); every one by default. */
    orgId?: string;
  },
): Promise<number> {
  const rows = (await tx.execute(sql`
    SELECT
      ordered.stream_id::text   AS stream_id,
      ordered.org_id::text      AS org_id,
      ordered.seq::int          AS seq,
      ordered.occurred_at       AS occurred_at,
      ordered.actor_id::text    AS actor_user_id,
      m.id::text                AS actor_member_id,
      ordered.type              AS type,
      ordered.payload           AS payload
    FROM (
      SELECT
        e.*,
        MAX(occurred_at) OVER (PARTITION BY stream_id ORDER BY seq) AS replay_at
      FROM domain.events e
      WHERE stream_type = ${cfg.streamType}
        ${cfg.orgId ? sql`AND org_id = ${cfg.orgId}` : sql``}
    ) ordered
    -- RUNAPI-25: the acting member, as the first projection had it
    -- (readStream looks it up the same way).
    LEFT JOIN auth.members m ON m.org_id = ordered.org_id AND m.user_id = ordered.actor_id
    ORDER BY ordered.replay_at, ordered.stream_id, ordered.seq
  `)) as unknown as Array<{
    stream_id: string;
    org_id: string;
    seq: number;
    occurred_at: Date;
    actor_user_id: string | null;
    actor_member_id: string | null;
    type: string;
    payload: unknown;
  }>;

  // Fold through the aggregate as we go: a stream the reducer cannot
  // follow (seq gap, unknown shape) should stop the rebuild, not be
  // projected on a guess.
  const states = new Map<string, S>();
  for (const row of rows) {
    const event = {
      streamId: row.stream_id,
      seq: row.seq,
      occurredAt: new Date(row.occurred_at),
      actorUserId: row.actor_user_id,
      actorMemberId: row.actor_member_id,
      type: row.type,
      payload: row.payload,
    } as unknown as E;
    try {
      states.set(
        row.stream_id,
        cfg.apply(states.get(row.stream_id) ?? cfg.empty(row.stream_id), event),
      );
      await cfg.project(tx as unknown as DB, row.org_id, [event]);
    } catch (err) {
      throw new Error(
        `${cfg.streamType} stream ${row.stream_id} seq ${row.seq} (${row.type}) could not be replayed`,
        { cause: err },
      );
    }
  }
  return states.size;
}
