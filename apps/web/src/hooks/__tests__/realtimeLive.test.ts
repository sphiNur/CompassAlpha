/**
 * P-4 (2026-10-31): the purchase screen polls run.get only while realtime
 * pushes are not arriving. The liveness rule and the flag pages read are
 * pinned here; the socket wiring itself needs a browser.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  WS_CLOSE_EVICTED,
  WS_CLOSE_MEMBERSHIP_ENDED,
  WS_CLOSE_TOKEN_EXPIRED,
} from '@compass/contracts/schemas/realtime';
import {
  REALTIME_STALE_MS,
  afterClose,
  getRealtimeLive,
  isRealtimeLive,
  isRealtimeStale,
  pollWhenOffline,
  setRealtimeLive,
} from '../useRealtime';

describe('isRealtimeLive', () => {
  const now = 1_000_000;

  it('a closed socket is never live', () => {
    expect(isRealtimeLive(false, now, now)).toBe(false);
  });

  it('an open socket is live while the 25 s pings keep coming', () => {
    expect(isRealtimeLive(true, now - 25_000, now)).toBe(true);
    expect(isRealtimeLive(true, now - REALTIME_STALE_MS, now)).toBe(true);
  });

  it('an open socket that has gone quiet (half-open after a network change) is not', () => {
    expect(isRealtimeLive(true, now - REALTIME_STALE_MS - 1, now)).toBe(false);
  });
});

describe('isRealtimeStale (COREWEB2-07)', () => {
  const now = 1_000_000;

  it('keeps a socket that hears the 25 s pings', () => {
    expect(isRealtimeStale(now - 25_000, now)).toBe(false);
    expect(isRealtimeStale(now - REALTIME_STALE_MS, now)).toBe(false);
  });

  it('gives up on one that has heard nothing for longer, or never got an answer', () => {
    expect(isRealtimeStale(now - REALTIME_STALE_MS - 1, now)).toBe(true);
  });
});

describe('pollWhenOffline', () => {
  it('polls only while realtime is down', () => {
    expect(pollWhenOffline(6_000, false)).toBe(6_000);
    expect(pollWhenOffline(6_000, true)).toBe(false);
  });
});

describe('realtime live flag', () => {
  // TEST3-07: the flag is module state shared with every other test file;
  // put it back down even when an assertion below fails, so "starts down"
  // keeps holding whatever order the files run in.
  afterEach(() => setRealtimeLive(false));

  it('starts down and follows transitions', () => {
    expect(getRealtimeLive()).toBe(false);
    setRealtimeLive(true);
    expect(getRealtimeLive()).toBe(true);
    setRealtimeLive(false);
    expect(getRealtimeLive()).toBe(false);
  });
});

describe('afterClose (review COREWEB2-24)', () => {
  it('an expired token is refreshed', () => {
    expect(afterClose(WS_CLOSE_TOKEN_EXPIRED)).toBe('refreshToken');
  });

  it('a member who left reads the session again instead of reconnecting', () => {
    expect(WS_CLOSE_MEMBERSHIP_ENDED).toBe(4003);
    expect(afterClose(WS_CLOSE_MEMBERSHIP_ENDED)).toBe('readSession');
  });

  it('anything else reconnects: an eviction, the server going away, a lost connection', () => {
    for (const code of [WS_CLOSE_EVICTED, 1000, 1001, 1006]) {
      expect(afterClose(code)).toBe('reconnect');
    }
  });
});
