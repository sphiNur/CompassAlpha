import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { closeDb, getDb, schema as s, withSystemContext, type DB } from '@compass/db';
import {
  claimLastActiveAt,
  claimRowForUpdateSql,
  isClaimExpired,
  nextSeq,
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

describe('nextSeq (RE-APR-1)', () => {
  test('a bigint seq read back as a string is added, not concatenated', () => {
    expect(nextSeq('17')).toBe(18);
    expect(nextSeq(8)).toBe(9);
    expect(nextSeq(0n)).toBe(1);
  });
  test('refuses a value that is not a seq', () => {
    expect(() => nextSeq('abc')).toThrow();
    expect(() => nextSeq(-1)).toThrow();
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

describe('claim timeout SQL', () => {
  const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

  test("order candidates use the claimer's last event on the order stream", () => {
    const q = dialect.sqlToQuery(staleClaimCandidatesSql('order', 30));
    const text = flat(q.sql);
    expect(text).toContain('FROM read_model.order_sessions_v c');
    expect(text).toContain("c.status = 'submitted'");
    expect(text).toContain('JOIN auth.members m ON m.user_id = e.actor_id');
    expect(text).toContain('e.stream_type = $1');
    expect(text).toContain('m.id = c.claimed_by_member_id');
    expect(text).toContain('WHERE GREATEST(claimed_at, last_claimer_event_at) < NOW() -');
    expect(q.params).toEqual(['order', 30, 30, 100]);
  });

  test('run candidates read market_runs_v and the run stream', () => {
    const q = dialect.sqlToQuery(staleClaimCandidatesSql('run', 15, 50));
    const text = flat(q.sql);
    expect(text).toContain('FROM read_model.market_runs_v c');
    expect(text).toContain("c.status IN ('planned', 'purchasing', 'delivering')");
    expect(q.params).toEqual(['run', 15, 15, 50]);
  });

  test('the locked re-check selects the claimer activity and locks only the claim row', () => {
    const q = dialect.sqlToQuery(claimRowForUpdateSql('order', 'sess-1'));
    const text = flat(q.sql);
    expect(text).toContain('AS last_claimer_event_at');
    expect(text).toContain('FOR UPDATE OF c');
    expect(q.params).toEqual(['order', 'sess-1']);
  });
});

// ---------------------------------------------------------------------------
// PG-gated: the same SQL against a migrated database. Not part of CI's
// integration job (that runs apps/api only); run locally with
// DATABASE_URL pointing at a scratch database.
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
    activeRun: randomUUID(),
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
    const session = (id: string) => ({
      id,
      orgId: ids.orgId,
      storeId: ids.storeId,
      orderDate: '2026-10-22',
      status: 'submitted',
      claimedByMemberId: ids.claimerMemberId,
      claimedAt: ago(60),
      lastSeq: 3,
    });
    await db
      .insert(s.orderSessionsV)
      .values([session(ids.activeOrder), session(ids.idleOrder), session(ids.othersActivityOrder)]);
    await db.insert(s.marketRunsV).values({
      id: ids.activeRun,
      orgId: ids.orgId,
      runDate: '2026-10-22',
      status: 'purchasing',
      claimedByMemberId: ids.claimerMemberId,
      claimedAt: ago(60),
      lastSeq: 2,
    });
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
    const seeded: string[] = [ids.activeOrder, ids.idleOrder, ids.othersActivityOrder];
    const mine = rows.filter((r) => seeded.includes(r.id));
    expect(mine.map((r) => r.id).sort()).toEqual([ids.idleOrder, ids.othersActivityOrder].sort());
  });

  test('run candidates skip a claimer who is still working the run', async () => {
    const rows = (await withSystemContext(db, 'worker', (tx) =>
      tx.execute(staleClaimCandidatesSql('run', 30, 10_000)),
    )) as unknown as Array<{ id: string }>;
    expect(rows.some((r) => r.id === ids.activeRun)).toBe(false);
  });

  test('the locked re-check returns the claimer activity for isClaimExpired', async () => {
    const [row] = (await withSystemContext(db, 'worker', (tx) =>
      tx.execute(claimRowForUpdateSql('order', ids.activeOrder)),
    )) as unknown as Array<{ claimed_at: string; last_claimer_event_at: string | null }>;
    expect(row).toBeDefined();
    // Raw execute returns timestamptz as a string, not a Date; the
    // helpers must accept that (the old `claimed_at.getTime()` threw).
    expect(typeof row!.claimed_at).toBe('string');
    // RE-APR-1: last_seq (bigint) also comes back as a string; the next
    // event's seq must be numeric, not "<seq>1".
    const seqRow = row as unknown as { last_seq: string | number };
    expect(nextSeq(seqRow.last_seq)).toBe(Number(seqRow.last_seq) + 1);
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
      releaseClaimIfExpired(tx, 'order', { id: ids.idleOrder, orgId: ids.orgId }, 30),
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
});
