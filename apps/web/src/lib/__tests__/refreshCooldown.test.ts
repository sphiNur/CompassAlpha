import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { authFetch, resetRefreshCooldownForTests } from '../trpc';
import { isLikelyNetworkError } from '../networkError';
import { errorTextKey } from '../errorText';
import { useAuthStore } from '../../stores/authStore';

// RE-AUTH-5 (2026-10-30): a refresh that never completed was attempted
// again by every query retry, each waiting out its own timeout — the order
// page spun for ~95 s before showing anything.
const realFetch = globalThis.fetch;
let calls: string[] = [];

beforeEach(() => {
  calls = [];
  resetRefreshCooldownForTests();
  useAuthStore.setState({ accessToken: 'stale', refreshToken: 'good-refresh' });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url.split('/trpc/')[1] ?? url);
    if (url.includes('auth.refresh')) {
      // The refresh is time-limited on its own, shorter than a write.
      expect(init?.signal).toBeDefined();
      throw new TypeError('Failed to fetch');
    }
    return new Response('{"error":{}}', { status: 401, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('authFetch when the session refresh does not complete', () => {
  it('fails as a network error and keeps the session', async () => {
    const err = await authFetch('/trpc/order.todaySession').catch((e) => e);
    expect(isLikelyNetworkError(err)).toBe(true);
    expect(useAuthStore.getState().refreshToken).toBe('good-refresh');
    expect(calls).toEqual(['order.todaySession', 'auth.refresh']);
  });

  it('a retry right after does not start another refresh — it fails at once', async () => {
    await authFetch('/trpc/order.todaySession').catch(() => {});
    calls = [];
    const err = await authFetch('/trpc/order.todaySession').catch((e) => e);
    expect(isLikelyNetworkError(err)).toBe(true);
    expect(calls).toEqual(['order.todaySession']);
  });
});

// R2-AUTH-3 (2026-10-31): a refresh the server answered with 500 is the
// server's problem; the page must not say "check your connection".
describe('authFetch when the session refresh gets a server error', () => {
  it('still fails as a network error (writes queue) but names the server status', async () => {
    resetRefreshCooldownForTests();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('auth.refresh')) {
        return new Response('{"error":{}}', { status: 500, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{"error":{}}', { status: 401, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const err = await authFetch('/trpc/order.todaySession').catch((e) => e);
    expect(isLikelyNetworkError(err)).toBe(true);
    expect(errorTextKey(err.message, 'common.errorUnknown')).toBe('common.errors.internal');
    expect(useAuthStore.getState().refreshToken).toBe('good-refresh');
    // The follow-up inside the cooldown says the same.
    const again = await authFetch('/trpc/order.todaySession').catch((e) => e);
    expect(errorTextKey(again.message, 'common.errorUnknown')).toBe('common.errors.internal');
  });
});
