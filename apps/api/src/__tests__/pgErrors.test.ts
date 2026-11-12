import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb, schema as s } from '@compass/db';
import { appendEvents, readStream } from '../services/eventStore';
import {
  isStreamSeqConflict,
  isUniqueViolation,
  pgErrorCode,
  withStreamConflictRetry,
} from '../services/pgErrors';
import { SHOULD_RUN } from './helpers/pg';
import { cleanUpAfterAll, noteOrg } from './helpers/cleanup';

cleanUpAfterAll();

describe('pgErrorCode', () => {
  test('reads the code off a bare driver error', () => {
    expect(pgErrorCode(Object.assign(new Error('duplicate key'), { code: '23505' }))).toBe('23505');
  });

  test('reads it through the wrapper the ORM puts around a failed query', () => {
    const driver = Object.assign(new Error('duplicate key'), { code: '23505' });
    const wrapped = new Error('Failed query: insert into …', { cause: driver });
    expect(pgErrorCode(wrapped)).toBe('23505');
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  test('is not fooled by codes that are not SQLSTATEs', () => {
    expect(pgErrorCode(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBeNull();
    expect(pgErrorCode(Object.assign(new Error('x'), { code: 'CONFLICT' }))).toBeNull();
    expect(pgErrorCode(new Error('plain'))).toBeNull();
    expect(pgErrorCode(null)).toBeNull();
  });

  test('tells a unique violation from other constraint failures', () => {
    const check = new Error('wrapped', { cause: Object.assign(new Error('c'), { code: '23514' }) });
    expect(pgErrorCode(check)).toBe('23514');
    expect(isUniqueViolation(check)).toBe(false);
  });

  test('gives up on a cause chain that loops', () => {
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(pgErrorCode(a)).toBeNull();
  });
});

describe('a real sequence collision in the event store (PG)', () => {
  /**
   * The check above is only worth anything if it recognises what the
   * installed ORM and driver actually throw. This appends the same
   * sequence number to one stream twice, for real.
   */
  test.skipIf(!SHOULD_RUN)('is recognised as a unique violation', async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    const [org] = await db
      .insert(s.organizations)
      .values({ slug: `pgerr-${randomUUID().slice(0, 8)}`, name: 'PG error probe' })
      .returning();
    if (!org) throw new Error('org insert failed');
    noteOrg(org.id);

    const append = () =>
      appendEvents(db, {
        streamType: 'order',
        streamId,
        orgId: org.id,
        events: [
          {
            type: 'ProbeAppended',
            seq: 1,
            payload: {},
            actorUserId: null,
            actorMemberId: null,
            occurredAt: new Date(),
          },
        ],
      });
    const streamId = randomUUID();

    await append();
    let thrown: unknown = null;
    try {
      await append();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
    expect(pgErrorCode(thrown)).toBe('23505');
    expect(isUniqueViolation(thrown)).toBe(true);
    // R2: and it is told apart as a stream-sequence race, the one kind a
    // command may simply decide again.
    expect(isStreamSeqConflict(thrown)).toBe(true);
  });

  /**
   * A wait that ends once `n` writers have called it: the writers of one
   * round each read the stream, then wait here for the others.
   */
  const allRead = (n: number) => {
    let arrived = 0;
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return () => {
      arrived += 1;
      if (arrived === n) open();
      return opened;
    };
  };

  test.skipIf(!SHOULD_RUN)(
    'R2: writers racing on one stream all land once each decision is retried',
    async () => {
      const db = getDb(undefined, { system: 'maintenance' });
      const [org] = await db
        .insert(s.organizations)
        .values({ slug: `pgretry-${randomUUID().slice(0, 8)}`, name: 'Stream retry probe' })
        .returning();
      if (!org) throw new Error('org insert failed');
      noteOrg(org.id);
      const streamId = randomUUID();

      // One "command": read the stream, decide, append the next sequence
      // number — all in one transaction. `decided` stands for the
      // deciding: it waits until every writer of the round has read.
      const command = (decided?: () => Promise<void>) =>
        db.transaction(async (tx) => {
          const seen = await readStream(tx as unknown as typeof db, 'order', streamId);
          await decided?.();
          await appendEvents(tx as unknown as typeof db, {
            streamType: 'order',
            streamId,
            orgId: org.id,
            events: [
              {
                type: 'ProbeAppended',
                seq: seen.length + 1,
                payload: {},
                actorUserId: null,
                actorMemberId: null,
                occurredAt: new Date(),
              },
            ],
          });
        });

      // Without retries the race really happens and is recognised: all
      // three read the empty stream before any appends, so two lose (review
      // TEST1-19: a 25 ms nap and the pool's size used to decide whether
      // they overlapped at all).
      const firstRound = allRead(3);
      const once = await Promise.allSettled([1, 2, 3].map(() => command(firstRound)));
      const lost = once.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(lost.length).toBe(2);
      for (const r of lost) expect(isStreamSeqConflict(r.reason)).toBe(true);

      // With retries every writer lands, on consecutive sequence numbers:
      // the four first tries race as above, the retries go as they come.
      const before = (await readStream(db, 'order', streamId)).length;
      const firstTries = allRead(4);
      await Promise.all(
        [1, 2, 3, 4].map(() => {
          let tries = 0;
          return withStreamConflictRetry(() => command(tries++ === 0 ? firstTries : undefined), 8);
        }),
      );
      const seqs = (await readStream(db, 'order', streamId)).map((e) => e.seq);
      expect(seqs.length).toBe(before + 4);
      expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    },
  );
});

describe('withStreamConflictRetry', () => {
  const seqRace = () =>
    new Error('Failed query', {
      cause: Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint_name: 'events_stream_seq_unique',
      }),
    });

  test('decides again after a stream race and returns the winner', async () => {
    let calls = 0;
    const out = await withStreamConflictRetry(async () => {
      calls += 1;
      if (calls < 3) throw seqRace();
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(calls).toBe(3);
  });

  test('rethrows a race it keeps losing, and never retries other errors', async () => {
    let calls = 0;
    await expect(
      withStreamConflictRetry(async () => {
        calls += 1;
        throw seqRace();
      }, 3),
    ).rejects.toThrow('Failed query');
    expect(calls).toBe(3);

    calls = 0;
    const otherUnique = Object.assign(new Error('dup'), { code: '23505', constraint_name: 'mrv_one_active_per_org_unique' });
    await expect(
      withStreamConflictRetry(async () => {
        calls += 1;
        throw otherUnique;
      }),
    ).rejects.toBe(otherUnique);
    expect(calls).toBe(1);
  });
});
