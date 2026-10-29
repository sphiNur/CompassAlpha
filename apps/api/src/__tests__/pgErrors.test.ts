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

const SHOULD_RUN = !!process.env.DATABASE_URL && process.env.SKIP_PG_TESTS !== '1';

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

  test.skipIf(!SHOULD_RUN)(
    'R2: writers racing on one stream all land once each decision is retried',
    async () => {
      const db = getDb(undefined, { system: 'maintenance' });
      const [org] = await db
        .insert(s.organizations)
        .values({ slug: `pgretry-${randomUUID().slice(0, 8)}`, name: 'Stream retry probe' })
        .returning();
      if (!org) throw new Error('org insert failed');
      const streamId = randomUUID();

      // One "command": read the stream, take a moment (as deciding does),
      // append the next sequence number — all in one transaction.
      const command = () =>
        db.transaction(async (tx) => {
          const seen = await readStream(tx as unknown as typeof db, 'order', streamId);
          await new Promise((resolve) => setTimeout(resolve, 25));
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

      // Without retries the race really happens and is recognised.
      const once = await Promise.allSettled([command(), command(), command()]);
      const lost = once.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(lost.length).toBeGreaterThan(0);
      for (const r of lost) expect(isStreamSeqConflict(r.reason)).toBe(true);

      // With retries every writer lands, on consecutive sequence numbers.
      const before = (await readStream(db, 'order', streamId)).length;
      await Promise.all(
        [1, 2, 3, 4].map(() => withStreamConflictRetry(command, 8)),
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
