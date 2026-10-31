/**
 * Tests for the offline-outbox flush decision logic.
 *
 * The hook wires IDB + React + connectivity events, which is hard to drive
 * headless. The two decisions that carry the risk are exported as pure
 * functions and pinned here (same pattern as useTapGuard):
 *
 *   - classifyEntry: the C1 data-loss regression guard. A queued financial
 *     write whose procedure the *currently mounted* page doesn't recognise
 *     must NOT be deleted — it belongs to another (unmounted) page and has
 *     to survive until that page can replay it. Only genuinely stale
 *     (retired-bundle) entries may be discarded.
 *   - classifyReplayError: terminal server rejections vs transient retries.
 */
import { describe, it, expect } from 'bun:test';
import {
  classifyEntry,
  classifyReplayError,
  countsTowardGiveUp,
  frozenOrderDate,
  localDateString,
  isOwnEntry,
  isRetryDue,
  samePendingWrites,
  shouldGiveUp,
  MAX_OVERRIDE_RETRIES,
  MAX_REPLAY_RETRIES,
} from '../useOfflineQueue';

const DAY = 24 * 60 * 60 * 1000;
const TTL = 7 * DAY;

describe('classifyEntry', () => {
  it('replays when a live handler is registered', () => {
    expect(classifyEntry(true, 0)).toBe('replay');
    expect(classifyEntry(true, 999 * DAY)).toBe('replay'); // age is irrelevant when replayable
  });

  it('SKIPS (never deletes) an unrecognised entry that is still fresh — the C1 fix', () => {
    // A purchase queued on RunPage, then the user switches to OrderPage
    // (which doesn't register run.purchaseItem) and reconnects. The entry
    // must be kept, not destroyed.
    expect(classifyEntry(false, 0)).toBe('skip');
    expect(classifyEntry(false, 1 * DAY)).toBe('skip');
    expect(classifyEntry(false, TTL)).toBe('skip'); // exactly at TTL is not yet expired
  });

  it('expires an unrecognised entry only once it is older than the TTL', () => {
    expect(classifyEntry(false, TTL + 1)).toBe('expire');
    expect(classifyEntry(false, 30 * DAY)).toBe('expire');
  });

  it('honours a custom TTL', () => {
    expect(classifyEntry(false, 500, 1000)).toBe('skip');
    expect(classifyEntry(false, 1500, 1000)).toBe('expire');
  });
});

describe('classifyReplayError', () => {
  it('drops on terminal rejections that can never succeed on retry', () => {
    expect(classifyReplayError('CONFLICT')).toBe('drop');
    expect(classifyReplayError('BAD_REQUEST')).toBe('drop');
    expect(classifyReplayError('NOT_FOUND')).toBe('drop');
    // H3: these two used to retry forever and head-of-line-block the queue.
    expect(classifyReplayError('PRECONDITION_FAILED')).toBe('drop'); // runFrozen
    expect(classifyReplayError('FORBIDDEN')).toBe('drop');
  });

  it('retries on transient / unknown failures (incl. no code)', () => {
    expect(classifyReplayError(undefined)).toBe('retry');
    expect(classifyReplayError('INTERNAL_SERVER_ERROR')).toBe('retry');
    expect(classifyReplayError('TIMEOUT')).toBe('retry');
    expect(classifyReplayError('TOO_MANY_REQUESTS')).toBe('retry');
  });

  it('does NOT drop on UNAUTHORIZED — a re-login lets a later flush succeed', () => {
    expect(classifyReplayError('UNAUTHORIZED')).toBe('retry');
  });

  // 2026-10-21 audit CA-25: a seq collision on the shared draft is not
  // the queued edit's fault — retry it a bounded number of times.
  it('retries order.adjustItem / setSessionExtras CONFLICT up to the override cap', () => {
    for (const proc of ['order.adjustItem', 'order.setSessionExtras']) {
      expect(classifyReplayError('CONFLICT', proc, 0)).toBe('retry');
      expect(classifyReplayError('CONFLICT', proc, MAX_OVERRIDE_RETRIES - 1)).toBe('retry');
      expect(classifyReplayError('CONFLICT', proc, MAX_OVERRIDE_RETRIES)).toBe('drop');
    }
  });

  // R2 (2026-10-30): a run's writes share one stream, so a replay that
  // races another writer is not at fault either — retry it, bounded.
  it('retries queued run writes on CONFLICT up to the override cap', () => {
    for (const proc of ['run.purchaseItem', 'run.confirmStore', 'run.deliverToStore']) {
      expect(classifyReplayError('CONFLICT', proc, 0)).toBe('retry');
      expect(classifyReplayError('CONFLICT', proc, MAX_OVERRIDE_RETRIES)).toBe('drop');
    }
  });

  it('keeps every other procedure / code on the default rule', () => {
    expect(classifyReplayError('CONFLICT', 'run.cancel', 0)).toBe('drop');
    expect(classifyReplayError('PRECONDITION_FAILED', 'run.purchaseItem', 0)).toBe('drop');
    // The stale-offline-edit refusal is terminal for adjustItem.
    expect(classifyReplayError('PRECONDITION_FAILED', 'order.adjustItem', 0)).toBe('drop');
    expect(classifyReplayError('BAD_REQUEST', 'order.adjustItem', 0)).toBe('drop');
    expect(classifyReplayError(undefined, 'order.adjustItem', 5)).toBe('retry');
  });
});

describe('shouldGiveUp', () => {
  it('keeps retrying below the cap', () => {
    expect(shouldGiveUp(0)).toBe(false);
    expect(shouldGiveUp(MAX_REPLAY_RETRIES - 1)).toBe(false);
  });

  it('gives up at or beyond the cap', () => {
    expect(shouldGiveUp(MAX_REPLAY_RETRIES)).toBe(true);
    expect(shouldGiveUp(MAX_REPLAY_RETRIES + 5)).toBe(true);
  });

  it('honours a custom cap', () => {
    expect(shouldGiveUp(2, 3)).toBe(false);
    expect(shouldGiveUp(3, 3)).toBe(true);
  });
});

describe('isOwnEntry', () => {
  it('replays an entry only for the user who queued it', () => {
    expect(isOwnEntry('u1', 'u1')).toBe(true);
    expect(isOwnEntry('u1', 'u2')).toBe(false);
  });

  it('replays nothing while signed out', () => {
    expect(isOwnEntry('u1', undefined)).toBe(false);
    expect(isOwnEntry(undefined, undefined)).toBe(false);
  });

  it('keeps replaying entries queued before ownership was recorded', () => {
    expect(isOwnEntry(undefined, 'u1')).toBe(true);
  });
});

describe('countsTowardGiveUp', () => {
  it('does not blame the entry for a lost request or a lapsed session', () => {
    expect(countsTowardGiveUp(undefined)).toBe(false);
    expect(countsTowardGiveUp('UNAUTHORIZED')).toBe(false);
  });

  it('counts failures the server actually returned', () => {
    expect(countsTowardGiveUp('INTERNAL_SERVER_ERROR')).toBe(true);
    expect(countsTowardGiveUp('TOO_MANY_REQUESTS')).toBe(true);
  });
});

describe('isRetryDue', () => {
  const now = 1_000_000;

  it('tries a fresh entry immediately', () => {
    expect(isRetryDue(0, undefined, now)).toBe(true);
  });

  it('waits longer after each counted failure, up to five minutes', () => {
    expect(isRetryDue(1, now - 4_000, now)).toBe(false);
    expect(isRetryDue(1, now - 5_000, now)).toBe(true);
    expect(isRetryDue(3, now - 19_000, now)).toBe(false);
    expect(isRetryDue(3, now - 20_000, now)).toBe(true);
    expect(isRetryDue(7, now - 299_000, now)).toBe(false);
    expect(isRetryDue(7, now - 300_000, now)).toBe(true);
  });

  it('eight page mounts in a row cannot spend the retry budget', () => {
    let retries = 1;
    for (let mount = 0; mount < MAX_REPLAY_RETRIES; mount++) {
      if (isRetryDue(retries, now, now + mount * 500)) retries += 1;
    }
    expect(retries).toBe(1);
  });
});

describe('frozenOrderDate (CA-25)', () => {
  const now = new Date(2026, 9, 21, 23, 59); // local 2026-10-21 23:59
  it("uses the shown session's order date when there is a real session", () => {
    expect(frozenOrderDate({ id: 'sess-1', orderDate: '2026-10-20' }, now)).toBe('2026-10-20');
  });
  it('falls back to the device-local date before a session exists', () => {
    expect(frozenOrderDate(null, now)).toBe('2026-10-21');
    expect(frozenOrderDate(undefined, now)).toBe('2026-10-21');
    // The optimistic placeholder's date is not server truth.
    expect(frozenOrderDate({ id: 'optimistic', orderDate: '2026-10-22' }, now)).toBe('2026-10-21');
  });
  it('formats local dates zero-padded', () => {
    expect(localDateString(new Date(2026, 0, 5, 0, 1))).toBe('2026-01-05');
  });
});

describe('samePendingWrites (P-3: no re-render when the outbox is unchanged)', () => {
  const w = (clientSeq: number) => ({ clientSeq, procedure: 'p', input: {}, enqueuedAt: 1 });

  it('two empty reads are the same, so the old [] is kept', () => {
    expect(samePendingWrites([], [])).toBe(true);
  });

  it('same clientSeqs in the same order are the same', () => {
    expect(samePendingWrites([w(1), w(2)], [w(1), w(2)])).toBe(true);
  });

  it('an added, removed or replaced entry is a change', () => {
    expect(samePendingWrites([w(1)], [w(1), w(2)])).toBe(false);
    expect(samePendingWrites([w(1), w(2)], [w(2)])).toBe(false);
    expect(samePendingWrites([w(1)], [w(3)])).toBe(false);
  });
});
