import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb, schema as s } from '@compass/db';
import { appendEvents } from '../services/eventStore';
import { isUniqueViolation, pgErrorCode } from '../services/pgErrors';

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
  });
});
