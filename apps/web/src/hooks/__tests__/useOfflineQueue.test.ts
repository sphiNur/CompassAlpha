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
import { classifyEntry, classifyReplayError } from '../useOfflineQueue';

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
  it('drops on terminal server rejections', () => {
    expect(classifyReplayError('CONFLICT')).toBe('drop');
    expect(classifyReplayError('BAD_REQUEST')).toBe('drop');
    expect(classifyReplayError('NOT_FOUND')).toBe('drop');
  });

  it('retries on transient / unknown failures (incl. no code)', () => {
    expect(classifyReplayError(undefined)).toBe('retry');
    expect(classifyReplayError('INTERNAL_SERVER_ERROR')).toBe('retry');
    expect(classifyReplayError('TIMEOUT')).toBe('retry');
    // PRECONDITION_FAILED (runFrozen) is intentionally NOT terminal here yet
    // — surfacing + capping it is the H3 follow-up.
    expect(classifyReplayError('PRECONDITION_FAILED')).toBe('retry');
  });
});
