/**
 * The orphaned-session repair against a migrated database (review ORD-07):
 * the session's real stream is replayed, the domain decides, and the API's
 * projector writes the read model. Which event a finished or a cancelled
 * run leads to is pinned by the domain's own tests (order/system.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { closeDb, getDb, schema as s, withSystemContext, type DB } from '@compass/db';
import { repairOrphanedSession } from './orphanRepair';

const SHOULD_RUN = !!process.env.DATABASE_URL && process.env.SKIP_PG_TESTS !== '1';

describe.skipIf(!SHOULD_RUN)('repairOrphanedSession (PG-gated)', () => {
  let db: DB;
  const ids = {
    orgId: randomUUID(),
    storeId: randomUUID(),
    userId: randomUUID(),
    memberId: randomUUID(),
    finishedRun: randomUUID(),
    cancelledRun: randomUUID(),
    liveRun: randomUUID(),
    finishedSession: randomUUID(),
    cancelledSession: randomUUID(),
    liveSession: randomUUID(),
  };

  /** Started, one line, submitted, approved and put in `runId`: seq 1 to 5. */
  const streamOf = (sessionId: string, runId: string) => {
    const by = ids.memberId;
    const steps: Array<[string, Record<string, unknown>]> = [
      [
        'DraftStarted',
        {
          orgId: ids.orgId,
          storeId: ids.storeId,
          initiatedByMemberId: by,
          orderDate: '2026-11-12',
        },
      ],
      [
        'ItemAdjusted',
        { skuId: randomUUID(), qty: '2', prevQty: '0', byMemberId: by, forMemberId: by },
      ],
      ['Submitted', { itemCount: 1, byMemberId: by }],
      ['Approved', { byMemberId: by }],
      ['AttachedToRun', { runId }],
    ];
    return steps.map(([type, payload], i) => ({
      id: randomUUID(),
      orgId: ids.orgId,
      streamType: 'order',
      streamId: sessionId,
      seq: i + 1,
      type,
      payload,
      actorId: ids.userId,
      occurredAt: new Date(Date.now() - (60 - i) * 60_000),
    }));
  };

  beforeAll(async () => {
    db = getDb(undefined, { system: 'maintenance' });
    await db.insert(s.organizations).values({
      id: ids.orgId,
      slug: `orphan-repair-${ids.orgId}`,
      name: 'Orphan Repair Test',
      localeDefault: 'en',
      timezone: 'UTC',
    });
    await db.insert(s.users).values({ id: ids.userId, displayName: 'Staff' });
    await db
      .insert(s.members)
      .values({ id: ids.memberId, orgId: ids.orgId, userId: ids.userId, status: 'active' });
    await db.insert(s.stores).values({ id: ids.storeId, orgId: ids.orgId, name: 'Store' });
    const run = (id: string, status: string, runIndex: number) => ({
      id,
      orgId: ids.orgId,
      runDate: '2026-11-12',
      runIndex,
      status,
      lastSeq: 1,
    });
    await db
      .insert(s.marketRunsV)
      .values([
        run(ids.finishedRun, 'finished', 0),
        run(ids.cancelledRun, 'cancelled', 1),
        run(ids.liveRun, 'purchasing', 2),
      ]);
    const session = (id: string, runId: string) => ({
      id,
      orgId: ids.orgId,
      storeId: ids.storeId,
      orderDate: '2026-11-12',
      status: 'in_run',
      runId,
      lastSeq: 5,
    });
    await db
      .insert(s.orderSessionsV)
      .values([
        session(ids.finishedSession, ids.finishedRun),
        session(ids.cancelledSession, ids.cancelledRun),
        session(ids.liveSession, ids.liveRun),
      ]);
    await db
      .insert(s.events)
      .values([
        ...streamOf(ids.finishedSession, ids.finishedRun),
        ...streamOf(ids.cancelledSession, ids.cancelledRun),
        ...streamOf(ids.liveSession, ids.liveRun),
      ]);
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(s.organizations).where(eq(s.organizations.id, ids.orgId));
    await db.delete(s.users).where(inArray(s.users.id, [ids.userId]));
    await closeDb();
  });

  const repair = (sessionId: string) =>
    withSystemContext(db, 'worker', (tx) =>
      repairOrphanedSession(tx, { id: sessionId, orgId: ids.orgId }),
    );
  const sessionRow = async (sessionId: string) => {
    const [row] = await db
      .select({
        status: s.orderSessionsV.status,
        runId: s.orderSessionsV.runId,
        lastSeq: s.orderSessionsV.lastSeq,
      })
      .from(s.orderSessionsV)
      .where(eq(s.orderSessionsV.id, sessionId));
    return row;
  };
  const eventsAfter = (sessionId: string, seq: number) =>
    db
      .select({
        seq: s.events.seq,
        type: s.events.type,
        payload: s.events.payload,
        actorId: s.events.actorId,
      })
      .from(s.events)
      .where(and(eq(s.events.streamId, sessionId), inArray(s.events.seq, [seq + 1, seq + 2])))
      .orderBy(asc(s.events.seq));

  test('a finished run: the session is archived and keeps its run', async () => {
    expect(await repair(ids.finishedSession)).toBe('Archived');
    expect(await sessionRow(ids.finishedSession)).toEqual({
      status: 'archived',
      runId: ids.finishedRun,
      lastSeq: 6,
    });
    expect(await eventsAfter(ids.finishedSession, 5)).toEqual([
      { seq: 6, type: 'Archived', payload: { reason: 'repair' }, actorId: null },
    ]);
    // Once repaired there is nothing left to do.
    expect(await repair(ids.finishedSession)).toBeNull();
  });

  test('a cancelled run: the session goes back to approved, out of the run', async () => {
    expect(await repair(ids.cancelledSession)).toBe('EjectedFromRun');
    expect(await sessionRow(ids.cancelledSession)).toEqual({
      status: 'approved',
      runId: null,
      lastSeq: 6,
    });
    expect(await eventsAfter(ids.cancelledSession, 5)).toEqual([
      {
        seq: 6,
        type: 'EjectedFromRun',
        payload: { runId: ids.cancelledRun, byMemberId: null, reason: 'repair' },
        actorId: null,
      },
    ]);
  });

  test('a run still going: the session is left alone', async () => {
    expect(await repair(ids.liveSession)).toBeNull();
    expect(await sessionRow(ids.liveSession)).toEqual({
      status: 'in_run',
      runId: ids.liveRun,
      lastSeq: 5,
    });
    expect(await eventsAfter(ids.liveSession, 5)).toEqual([]);
  });
});
