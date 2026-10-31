/** 2026-10-21 FE-01: a failed todaySession must not render an editable empty catalog. */
import { describe, it, expect } from 'bun:test';
import { sessionLoadState } from '../sessionLoadState';

describe('sessionLoadState', () => {
  it('success is ok', () => {
    expect(sessionLoadState({ isError: false, hasData: false, isNetworkError: false })).toBe('ok');
    expect(sessionLoadState({ isError: false, hasData: true, isNetworkError: false })).toBe('ok');
  });

  it('error without cached data blocks the page (server or network error)', () => {
    expect(sessionLoadState({ isError: true, hasData: false, isNetworkError: false })).toBe(
      'blocked',
    );
    expect(sessionLoadState({ isError: true, hasData: false, isNetworkError: true })).toBe(
      'blocked',
    );
  });

  it('failed background refetch keeps cached data with a small warning', () => {
    expect(sessionLoadState({ isError: true, hasData: true, isNetworkError: false })).toBe(
      'staleWarning',
    );
  });

  it('network failure with cached data stays silent (offline path)', () => {
    expect(sessionLoadState({ isError: true, hasData: true, isNetworkError: true })).toBe('ok');
  });

  // R2-ENG-1 (2026-10-31): offline with nothing saved the query waits
  // (paused) — not "no session", which would offer an editable catalog.
  it('waiting offline with no data blocks as offline; saved data is used', () => {
    expect(
      sessionLoadState({ isError: false, hasData: false, isNetworkError: false, waitingOffline: true }),
    ).toBe('offline');
    expect(
      sessionLoadState({ isError: false, hasData: true, isNetworkError: false, waitingOffline: true }),
    ).toBe('ok');
  });
});
