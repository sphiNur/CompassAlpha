/**
 * Review ORD-14 (2026-11): the order projector stamps each read-model write
 * with its event's time, so a replay writes the same rows as the first
 * run did. Pure: a stand-in database records what would be written.
 */
import { describe, expect, setSystemTime, test } from 'bun:test';
import type { DB } from '@compass/db';
import type { OrderEvent } from '@compass/domain/order';
import { projectOrder } from '@compass/streams';

type Write = Record<string, unknown>;

/** Records the values of every insert, upsert and update the projector sends. */
function recordingDb(): { db: DB; writes: Write[] } {
  const writes: Write[] = [];
  const answered = (): Promise<Array<{ id: string }>> => Promise.resolve([{ id: 'stored' }]);
  const statement = (values: Write) => {
    writes.push(values);
    return {
      onConflictDoNothing: () => ({ returning: answered }),
      onConflictDoUpdate: (config: { set: Write }) => {
        writes.push(config.set);
        return answered();
      },
      where: answered,
    };
  };
  const db = {
    insert: () => ({ values: statement }),
    update: () => ({ set: statement }),
  };
  return { db: db as unknown as DB, writes };
}

const START = Date.parse('2026-05-02T08:00:00Z');

/** Event `seq` of stream s1, at its own minute past START. */
function event<T extends OrderEvent['type']>(
  seq: number,
  type: T,
  payload: Extract<OrderEvent, { type: T }>['payload'],
): OrderEvent {
  return {
    streamId: 's1',
    seq,
    occurredAt: new Date(START + seq * 60_000),
    actorUserId: 'u1',
    actorMemberId: 'm1',
    type,
    payload,
  } as OrderEvent;
}

/** One event of every type, in an order a session can go through. */
const LIFE: OrderEvent[] = [
  event(1, 'DraftStarted', {
    orgId: 'o1',
    storeId: 'st1',
    initiatedByMemberId: 'm1',
    orderDate: '2026-05-02',
  }),
  event(2, 'ItemAdjusted', {
    skuId: 'k1',
    qty: '2',
    prevQty: '0',
    byMemberId: 'm1',
    forMemberId: 'm1',
  }),
  event(3, 'ItemNoteSet', { skuId: 'k1', note: 'ripe', byMemberId: 'm1', forMemberId: 'm1' }),
  event(4, 'SessionNoteSet', { note: 'bread', byMemberId: 'm1' }),
  event(5, 'SessionExtrasSet', {
    extras: [{ name: 'salt', qty: '1', unit: 'kg' }],
    byMemberId: 'm1',
  }),
  event(6, 'Submitted', { itemCount: 1, byMemberId: 'm1' }),
  event(7, 'Claimed', { byMemberId: 'm2' }),
  event(8, 'ClaimReleased', { byMemberId: 'm2', reason: 'manual' }),
  event(9, 'Rejected', { byMemberId: 'm2', reason: 'too much' }),
  event(10, 'Withdrawn', { byMemberId: 'm1' }),
  event(11, 'Approved', { byMemberId: 'm2' }),
  event(12, 'Unapproved', { byMemberId: 'm2' }),
  event(13, 'AttachedToRun', { runId: 'r1' }),
  event(14, 'ExtraStatusSet', { extraIndex: 0, status: 'bought', byMemberId: 'm3' }),
  event(15, 'EjectedFromRun', { runId: 'r1', byMemberId: 'm3' }),
  event(16, 'Archived', { reason: 'run_finished' }),
];

describe('projectOrder (ORD-14)', () => {
  test('the session row takes each event’s time, not the clock at projection', async () => {
    for (const e of LIFE) {
      const { db, writes } = recordingDb();
      await projectOrder(db, 'o1', [e]);
      // Every event type writes something; none falls through unprojected.
      expect(writes.length).toBeGreaterThan(0);
      for (const w of writes) {
        if ('updatedAt' in w) expect(w.updatedAt).toEqual(e.occurredAt);
      }
      // At least the session row's updatedAt is written by each event.
      expect(writes.some((w) => 'updatedAt' in w)).toBe(true);
    }
  });

  test('a replay a year later writes the same values', async () => {
    const first = recordingDb();
    await projectOrder(first.db, 'o1', LIFE);
    const replay = recordingDb();
    setSystemTime(new Date('2027-05-02T08:00:00Z'));
    try {
      await projectOrder(replay.db, 'o1', LIFE);
    } finally {
      setSystemTime();
    }
    const stamps = (writes: Write[]) => writes.map((w) => [w.lastSeq, w.updatedAt]);
    expect(stamps(replay.writes)).toEqual(stamps(first.writes));
  });

  test('covers every event type of the domain', () => {
    // Checked by the compiler against the event union.
    const every: Record<OrderEvent['type'], true> = {
      DraftStarted: true,
      ItemAdjusted: true,
      ItemNoteSet: true,
      SessionNoteSet: true,
      SessionExtrasSet: true,
      ExtraStatusSet: true,
      Submitted: true,
      Claimed: true,
      ClaimReleased: true,
      Approved: true,
      Rejected: true,
      Withdrawn: true,
      Unapproved: true,
      AttachedToRun: true,
      EjectedFromRun: true,
      Archived: true,
    };
    const projected: string[] = [...new Set(LIFE.map((e) => e.type))];
    expect(projected.sort()).toEqual(Object.keys(every).sort());
  });
});
