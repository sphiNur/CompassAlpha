import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { closeDb, getDb, schema as s, withSystemContext, type DB } from '@compass/db';
import {
  claimLastActiveAt,
  claimRowForUpdateSql,
  isClaimExpired,
  releaseClaimIfExpired,
  staleClaimCandidatesSql,
} from './claimTimeout';

const dialect = new PgDialect();
const NOW = new Date('2026-10-22T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe('claimLastActiveAt', () => {
  test('is the claim time when the claimer has no later event', () => {
    expect(claimLastActiveAt(minutesAgo(40), null)).toEqual(minutesAgo(40));
    expect(claimLastActiveAt(minutesAgo(40), minutesAgo(50))).toEqual(minutesAgo(40));
  });

  test("is the claimer's newest event when that is later", () => {
    expect(claimLastActiveAt(minutesAgo(40), minutesAgo(3))).toEqual(minutesAgo(3));
  });
});

describe('timestamps as raw tx.execute returns them (strings)', () => {
  test('string timestamps are compared as instants', () => {
    expect(claimLastActiveAt('2026-10-22 11:00:00+00', '2026-10-22 16:30:00+05')).toEqual(
      new Date('2026-10-22T11:30:00Z'),
    );
    expect(
      isClaimExpired({
        claimedAt: '2026-10-22 10:00:00+00',
        lastClaimerEventAt: '2026-10-22 11:55:00+00',
        now: NOW,
        timeoutMinutes: 30,
      }),
    ).toBe(false);
    expect(
      isClaimExpired({
        claimedAt: '2026-10-22 10:00:00+00',
        lastClaimerEventAt: null,
        now: NOW,
        timeoutMinutes: 30,
      }),
    ).toBe(true);
  });
});

describe('isClaimExpired', () => {
  const base = { now: NOW, timeoutMinutes: 30 };

  test('an untouched claim expires after the timeout', () => {
    expect(isClaimExpired({ ...base, claimedAt: minutesAgo(31), lastClaimerEventAt: null })).toBe(
      true,
    );
    expect(isClaimExpired({ ...base, claimedAt: minutesAgo(29), lastClaimerEventAt: null })).toBe(
      false,
    );
  });

  test('an approver still editing is not released mid-review', () => {
    // Claimed 45 minutes ago, last edit 5 minutes ago → idle for 5 minutes.
    expect(
      isClaimExpired({ ...base, claimedAt: minutesAgo(45), lastClaimerEventAt: minutesAgo(5) }),
    ).toBe(false);
  });

  test('the claim expires once the last edit is older than the timeout', () => {
    expect(
      isClaimExpired({ ...base, claimedAt: minutesAgo(90), lastClaimerEventAt: minutesAgo(31) }),
    ).toBe(true);
  });

  test('an event older than the claim does not shorten the timeout', () => {
    expect(
      isClaimExpired({ ...base, claimedAt: minutesAgo(10), lastClaimerEventAt: minutesAgo(60) }),
    ).toBe(false);
  });

  test('exactly at the threshold is not yet expired', () => {
    expect(isClaimExpired({ ...base, claimedAt: minutesAgo(30), lastClaimerEventAt: null })).toBe(
      false,
    );
  });

  test('timeoutMinutes <= 0 disables expiry', () => {
    expect(
      isClaimExpired({
        claimedAt: minutesAgo(10_000),
        lastClaimerEventAt: null,
        now: NOW,
        timeoutMinutes: 0,
      }),
    ).toBe(false);
  });
});

// Review TEST4-17 (2026-11): only what a query's text must say. What the
// joins and the status filters select is pinned by the PG tests below,
// which CI's integration job now runs.
describe('claim timeout SQL', () => {
  const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

  test('candidates bind the stream type, the timeout twice and the batch size, in order', () => {
    expect(dialect.sqlToQuery(staleClaimCandidatesSql('order', 30)).params).toEqual([
      'order',
      30,
      30,
      100,
    ]);
    expect(dialect.sqlToQuery(staleClaimCandidatesSql('run', 15, 50)).params).toEqual([
      'run',
      15,
      15,
      50,
    ]);
  });

  test('the locked re-check locks only the claim row', () => {
    const q = dialect.sqlToQuery(claimRowForUpdateSql('order', 'sess-1'));
    expect(flat(q.sql)).toContain('FOR UPDATE OF c');
    expect(q.params).toEqual(['order', 'sess-1']);
  });
});

// ---------------------------------------------------------------------------
// PG-gated: the same SQL against a migrated database. CI's integration job
// runs these as its non-owner role; locally, point DATABASE_URL at a
// scratch database.
// ---------------------------------------------------------------------------
const SHOULD_RUN = !!process.env.DATABASE_URL && process.env.SKIP_PG_TESTS !== '1';

describe.skipIf(!SHOULD_RUN)('claim timeout SQL (PG-gated)', () => {
  let db: DB;
  const ids = {
    orgId: randomUUID(),
    storeId: randomUUID(),
    claimerUserId: randomUUID(),
    claimerMemberId: randomUUID(),
    otherUserId: randomUUID(),
    otherMemberId: randomUUID(),
    activeOrder: randomUUID(),
    idleOrder: randomUUID(),
    othersActivityOrder: randomUUID(),
    approvedOrder: randomUUID(),
    /** Idle like idleOrder. D13 releases this one, so the candidate
     * tests keep theirs whatever the order (review NEW-RAND-01). */
    releasedOrder: randomUUID(),
    activeRun: randomUUID(),
    deliveringRun: randomUUID(),
    finishedRun: randomUUID(),
    /** Delivering, its claimer idle; released below. (Not planned: an
     * organization has one planned or purchasing run, activeRun.) */
    releasedRun: randomUUID(),
  };

  beforeAll(async () => {
    db = getDb(undefined, { system: 'maintenance' });
    const ago = (m: number) => new Date(Date.now() - m * 60_000);

    await db.insert(s.organizations).values({
      id: ids.orgId,
      slug: `claim-timeout-${ids.orgId}`,
      name: 'Claim Timeout Test',
      localeDefault: 'en',
      timezone: 'UTC',
    });
    await db.insert(s.users).values([
      { id: ids.claimerUserId, displayName: 'Claimer' },
      { id: ids.otherUserId, displayName: 'Staff' },
    ]);
    await db.insert(s.members).values([
      { id: ids.claimerMemberId, orgId: ids.orgId, userId: ids.claimerUserId, status: 'active' },
      { id: ids.otherMemberId, orgId: ids.orgId, userId: ids.otherUserId, status: 'active' },
    ]);
    await db.insert(s.stores).values({ id: ids.storeId, orgId: ids.orgId, name: 'Store' });
    const session = (id: string, status = 'submitted', lastSeq = 3) => ({
      id,
      orgId: ids.orgId,
      storeId: ids.storeId,
      orderDate: '2026-10-22',
      status,
      claimedByMemberId: ids.claimerMemberId,
      claimedAt: ago(60),
      lastSeq,
    });
    await db.insert(s.orderSessionsV).values([
      session(ids.activeOrder),
      session(ids.idleOrder),
      session(ids.othersActivityOrder),
      session(ids.releasedOrder, 'submitted', 4),
      // Idle too, but no longer in review: never a candidate.
      session(ids.approvedOrder, 'approved'),
    ]);
    const run = (id: string, status: string, runIndex: number, lastSeq = 2) => ({
      id,
      orgId: ids.orgId,
      runDate: '2026-10-22',
      runIndex,
      status,
      claimedByMemberId: ids.claimerMemberId,
      claimedAt: ago(60),
      lastSeq,
    });
    await db.insert(s.marketRunsV).values([
      run(ids.activeRun, 'purchasing', 0),
      // No event from the claimer since the claim an hour ago.
      run(ids.deliveringRun, 'delivering', 1),
      run(ids.finishedRun, 'finished', 2),
      run(ids.releasedRun, 'delivering', 3, 4),
    ]);
    const event = (
      streamType: 'order' | 'run',
      streamId: string,
      seq: number,
      actorId: string,
      minutes: number,
    ) => ({
      id: randomUUID(),
      orgId: ids.orgId,
      streamType,
      streamId,
      seq,
      type: 'ItemAdjusted',
      payload: {},
      actorId,
      occurredAt: ago(minutes),
    });
    await db.insert(s.events).values([
      // Claimer edited 5 minutes ago → still active.
      event('order', ids.activeOrder, 1, ids.claimerUserId, 60),
      event('order', ids.activeOrder, 2, ids.claimerUserId, 5),
      // Claimer's last edit was 45 minutes ago → idle.
      event('order', ids.idleOrder, 1, ids.claimerUserId, 60),
      event('order', ids.idleOrder, 2, ids.claimerUserId, 45),
      // Only someone else touched it recently → the claimer is idle.
      event('order', ids.othersActivityOrder, 1, ids.claimerUserId, 60),
      event('order', ids.othersActivityOrder, 2, ids.otherUserId, 2),
      // Run claimer active 5 minutes ago on the run stream.
      event('run', ids.activeRun, 1, ids.claimerUserId, 60),
      event('run', ids.activeRun, 2, ids.claimerUserId, 5),
    ]);
    // The streams the releases replay (review ORD-07): the domain decides a
    // release from them, so they are the real events. The claimer's last
    // event on each is its claim, 45 minutes ago.
    const real = (
      streamType: 'order' | 'run',
      streamId: string,
      steps: Array<[string, Record<string, unknown>, string, number]>,
    ) =>
      steps.map(([type, payload, actorId, minutes], i) => ({
        ...event(streamType, streamId, i + 1, actorId, minutes),
        type,
        payload,
      }));
    await db.insert(s.events).values([
      ...real('order', ids.releasedOrder, [
        [
          'DraftStarted',
          {
            orgId: ids.orgId,
            storeId: ids.storeId,
            initiatedByMemberId: ids.otherMemberId,
            orderDate: '2026-10-22',
          },
          ids.otherUserId,
          70,
        ],
        [
          'ItemAdjusted',
          {
            skuId: randomUUID(),
            qty: '1',
            prevQty: '0',
            byMemberId: ids.otherMemberId,
            forMemberId: ids.otherMemberId,
          },
          ids.otherUserId,
          70,
        ],
        ['Submitted', { itemCount: 1, byMemberId: ids.otherMemberId }, ids.otherUserId, 65],
        ['Claimed', { byMemberId: ids.claimerMemberId }, ids.claimerUserId, 45],
      ]),
      ...real('run', ids.releasedRun, [
        [
          'RunPlanned',
          {
            orgId: ids.orgId,
            runDate: '2026-10-22',
            runIndex: 3,
            sessionIds: [],
            plannedItems: [{ skuId: randomUUID(), qty: '1' }],
            purchaserMemberId: ids.claimerMemberId,
          },
          ids.otherUserId,
          70,
        ],
        ['PurchaseStarted', {}, ids.otherUserId, 65],
        ['DeliveryStarted', {}, ids.otherUserId, 50],
        ['RunClaimed', { byMemberId: ids.claimerMemberId }, ids.claimerUserId, 45],
      ]),
    ]);
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(s.organizations).where(eq(s.organizations.id, ids.orgId));
    await db.delete(s.users).where(inArray(s.users.id, [ids.claimerUserId, ids.otherUserId]));
    await closeDb();
  });

  test('order candidates skip a claimer who is still editing', async () => {
    const rows = (await withSystemContext(db, 'worker', (tx) =>
      tx.execute(staleClaimCandidatesSql('order', 30, 10_000)),
    )) as unknown as Array<{ id: string }>;
    const seeded: string[] = [
      ids.activeOrder,
      ids.idleOrder,
      ids.othersActivityOrder,
      ids.approvedOrder,
    ];
    const mine = rows.filter((r) => seeded.includes(r.id));
    expect(mine.map((r) => r.id).sort()).toEqual([ids.idleOrder, ids.othersActivityOrder].sort());
  });

  test('run candidates: an idle claim on a live run, never one being worked or finished', async () => {
    const rows = (await withSystemContext(db, 'worker', (tx) =>
      tx.execute(staleClaimCandidatesSql('run', 30, 10_000)),
    )) as unknown as Array<{ id: string }>;
    const seeded: string[] = [ids.activeRun, ids.deliveringRun, ids.finishedRun];
    expect(rows.filter((r) => seeded.includes(r.id)).map((r) => r.id)).toEqual([ids.deliveringRun]);
  });

  test('the locked re-check returns the claimer activity for isClaimExpired', async () => {
    const [row] = (await withSystemContext(db, 'worker', (tx) =>
      tx.execute(claimRowForUpdateSql('order', ids.activeOrder)),
    )) as unknown as Array<{ claimed_at: string; last_claimer_event_at: string | null }>;
    expect(row).toBeDefined();
    // Raw execute returns timestamptz as a string, not a Date; the
    // helpers must accept that (the old `claimed_at.getTime()` threw).
    expect(typeof row!.claimed_at).toBe('string');
    expect(row!.last_claimer_event_at).not.toBeNull();
    expect(
      isClaimExpired({
        claimedAt: row!.claimed_at,
        lastClaimerEventAt: row!.last_claimer_event_at,
        now: new Date(),
        timeoutMinutes: 30,
      }),
    ).toBe(false);
  });

  test('D13: releasing an idle order claim leaves the claimer one in-app notification', async () => {
    const released = await withSystemContext(db, 'worker', (tx) =>
      releaseClaimIfExpired(tx, 'order', { id: ids.releasedOrder, orgId: ids.orgId }, 30),
    );
    expect(released).toBe(true);
    const notes = await withSystemContext(db, 'worker', (tx) =>
      tx
        .select()
        .from(s.notifications)
        .where(eq(s.notifications.recipientUserId, ids.claimerUserId)),
    );
    expect(notes.map((n) => [n.template, n.channel])).toEqual([['order.claimTimedOut', 'inapp']]);
    // No Telegram message: nothing queued for the bot.
    const queued = await withSystemContext(db, 'worker', (tx) =>
      tx.execute(
        sql`SELECT count(*)::int AS n FROM sync.outbox WHERE payload->>'recipientUserId' = ${ids.claimerUserId}`,
      ),
    );
    expect((queued as unknown as Array<{ n: number }>)[0]!.n).toBe(0);
  });

  /** The event a release appended, and the claim columns after it. */
  const releaseOf = async (
    table: typeof s.orderSessionsV | typeof s.marketRunsV,
    id: string,
    seq: number,
  ) => {
    const [event] = await db
      .select({ type: s.events.type, payload: s.events.payload, actorId: s.events.actorId })
      .from(s.events)
      .where(and(eq(s.events.streamId, id), eq(s.events.seq, seq)));
    const [row] = await db
      .select({
        claimedByMemberId: table.claimedByMemberId,
        claimedAt: table.claimedAt,
        previousClaimerMemberId: table.previousClaimerMemberId,
        lastSeq: table.lastSeq,
      })
      .from(table)
      .where(eq(table.id, id));
    return { event, row };
  };

  test('ORD-07: the order release is the domain event, projected like the API projects it', async () => {
    // Released by the D13 test above, after the claim at seq 4.
    expect(await releaseOf(s.orderSessionsV, ids.releasedOrder, 5)).toEqual({
      event: {
        type: 'ClaimReleased',
        payload: { byMemberId: null, reason: 'timeout' },
        actorId: null,
      },
      row: {
        claimedByMemberId: null,
        claimedAt: null,
        previousClaimerMemberId: ids.claimerMemberId,
        lastSeq: 5,
      },
    });
  });

  test('ORD-07: an idle run claim is released the same way', async () => {
    const released = await withSystemContext(db, 'worker', (tx) =>
      releaseClaimIfExpired(tx, 'run', { id: ids.releasedRun, orgId: ids.orgId }, 30),
    );
    expect(released).toBe(true);
    expect(await releaseOf(s.marketRunsV, ids.releasedRun, 5)).toEqual({
      event: {
        type: 'RunClaimReleased',
        payload: { byMemberId: null, reason: 'timeout' },
        actorId: null,
      },
      row: {
        claimedByMemberId: null,
        claimedAt: null,
        previousClaimerMemberId: ids.claimerMemberId,
        lastSeq: 5,
      },
    });
    // Nothing more to release.
    const again = await withSystemContext(db, 'worker', (tx) =>
      releaseClaimIfExpired(tx, 'run', { id: ids.releasedRun, orgId: ids.orgId }, 30),
    );
    expect(again).toBe(false);
  });
});
