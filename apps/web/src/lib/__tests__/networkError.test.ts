/**
 * Tests for the network-error vs server-error classifier.
 *
 * The whole point of `isLikelyNetworkError` is to keep us from enqueuing
 * domain errors (CONFLICT / FORBIDDEN / NOT_FOUND) into the offline
 * outbox where they'd retry forever. These tests pin the behavior so
 * the next person reading them can't accidentally widen the heuristic.
 */
import { describe, it, expect } from 'bun:test';
import { isLikelyNetworkError, isRefreshRejected } from '../networkError';

describe('isLikelyNetworkError', () => {
  it('returns true for typical iOS WebView "Load failed" message', () => {
    expect(isLikelyNetworkError({ message: 'Load failed' })).toBe(true);
    expect(isLikelyNetworkError({ message: 'TRPCClientError: Load failed' })).toBe(true);
  });

  it('returns true for Chrome / Firefox "Failed to fetch"', () => {
    expect(isLikelyNetworkError({ message: 'Failed to fetch' })).toBe(true);
  });

  it('returns true when err.cause is a TypeError (DNS / connection refused)', () => {
    expect(isLikelyNetworkError({ cause: { name: 'TypeError', message: 'fetch failed' } })).toBe(true);
  });

  it('returns false for typical TRPC server errors', () => {
    expect(isLikelyNetworkError({ message: 'CONFLICT' })).toBe(false);
    expect(isLikelyNetworkError({ message: 'FORBIDDEN: not allowed' })).toBe(false);
    expect(isLikelyNetworkError({ message: 'order.errors.alreadyClaimed' })).toBe(false);
  });

  it('returns false for null/undefined input (defensive)', () => {
    expect(isLikelyNetworkError(null)).toBe(false);
    expect(isLikelyNetworkError(undefined)).toBe(false);
    expect(isLikelyNetworkError({})).toBe(false);
  });

  it('does NOT confuse a domain error message that *contains* "fetch"', () => {
    // Edge case: a future i18n string might include the word "fetch".
    // Our heuristic uses "Failed to fetch" specifically, so a stray
    // "fetch" in unrelated copy won't trigger it.
    expect(isLikelyNetworkError({ message: 'could not fetch user' })).toBe(false);
  });
});

describe('isRefreshRejected', () => {
  it('ends the session when the server refuses the token', () => {
    expect(isRefreshRejected(401)).toBe(true);
    expect(isRefreshRejected(403)).toBe(true);
  });

  it('ends the session when the server cannot even parse the token', () => {
    // auth.refresh answers 400 to input that fails its schema. Keeping the
    // session here strands the client: nothing it holds will ever work.
    expect(isRefreshRejected(400)).toBe(true);
    expect(isRefreshRejected(404)).toBe(true);
    expect(isRefreshRejected(422)).toBe(true);
  });

  it('keeps the session through outages, timeouts and throttling', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(isRefreshRejected(status)).toBe(false);
    }
  });
});
