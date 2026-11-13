/** Review CONF-12: which CONFLICT is "changed since you read it". */
import { describe, expect, test } from 'bun:test';
import { conflictKind, isStaleVersionError, isStaleVersionKey } from '../conflict';

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

describe('isStaleVersionError (UX-22)', () => {
  test("the order's, the close's and the run's stale key", () => {
    expect(isStaleVersionError(conflict('order.errors.staleSeq'))).toBe(true);
    expect(isStaleVersionError(conflict('run.errors.staleSeq'))).toBe(true);
    // A replayed outbox error keeps only the message.
    expect(isStaleVersionError({ message: 'run.errors.staleSeq' })).toBe(true);
    // A domain error may carry the key in data.i18nKey.
    expect(isStaleVersionError({ message: 'x', data: { i18nKey: 'order.errors.staleSeq' } })).toBe(
      true,
    );
  });

  test('anything else is not', () => {
    expect(isStaleVersionError(conflict('common.errors.requestInFlight'))).toBe(false);
    expect(isStaleVersionError(conflict('order.errors.staleOfflineEdit'))).toBe(false);
    expect(isStaleVersionError(new Error('network'))).toBe(false);
    expect(isStaleVersionError(null)).toBe(false);
    expect(isStaleVersionError(undefined)).toBe(false);
    expect(isStaleVersionKey(undefined)).toBe(false);
    expect(isStaleVersionKey(42)).toBe(false);
  });
});
