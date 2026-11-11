/** Review CONF-12: which CONFLICT is "changed since you read it". */
import { describe, expect, test } from 'bun:test';
import { conflictKind } from '../conflict';

const conflict = (message: string) => ({ message, data: { code: 'CONFLICT' } });

describe('conflictKind (CONF-12)', () => {
  test('a stale version or sequence is the only "someone else changed it"', () => {
    expect(conflictKind(conflict('order.errors.staleSeq'))).toBe('stale');
    // A replayed outbox error keeps the message, not always the code.
    expect(conflictKind({ message: 'order.errors.staleSeq' })).toBe('stale');
  });

  test("the idempotency middleware's answers are not conflicts with another person", () => {
    expect(conflictKind(conflict('common.errors.requestInFlight'))).toBe('inFlight');
    expect(conflictKind(conflict('common.errors.idempotencyKeyReused'))).toBe('keyReused');
  });

  test('anything else is not classified', () => {
    expect(conflictKind(conflict('admin.errors.codeTaken'))).toBeNull();
    expect(conflictKind({ message: 'x', data: { code: 'BAD_REQUEST' } })).toBeNull();
    expect(conflictKind(new Error('network'))).toBeNull();
    expect(conflictKind(null)).toBeNull();
    expect(conflictKind(undefined)).toBeNull();
  });
});
