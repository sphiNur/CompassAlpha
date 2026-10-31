/**
 * P-4 (2026-10-31): the purchase screen polls run.get only while realtime
 * pushes are not arriving. The liveness rule and the flag pages read are
 * pinned here; the socket wiring itself needs a browser.
 */
import { describe, expect, it } from 'bun:test';
import {
  REALTIME_STALE_MS,
  getRealtimeLive,
  isRealtimeLive,
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

describe('pollWhenOffline', () => {
  it('polls only while realtime is down', () => {
    expect(pollWhenOffline(6_000, false)).toBe(6_000);
    expect(pollWhenOffline(6_000, true)).toBe(false);
  });
});

describe('realtime live flag', () => {
  it('starts down and follows transitions', () => {
    expect(getRealtimeLive()).toBe(false);
    setRealtimeLive(true);
    expect(getRealtimeLive()).toBe(true);
    setRealtimeLive(false);
    expect(getRealtimeLive()).toBe(false);
  });
});
