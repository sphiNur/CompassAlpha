/**
 * Tests for the network-error vs server-error classifier.
 *
 * The whole point of `isLikelyNetworkError` is to keep us from enqueuing
 * domain errors (CONFLICT / FORBIDDEN / NOT_FOUND) into the offline
 * outbox where they'd retry forever. These tests pin the behavior so
 * the next person reading them can't accidentally widen the heuristic.
 */
import { describe, it, expect } from 'bun:test';
import { isLikelyNetworkError } from '../networkError';

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
