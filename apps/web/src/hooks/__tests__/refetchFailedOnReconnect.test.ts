import { describe, expect, it } from 'bun:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';

import { failedQuery, refetchFailedQueries } from '../useRefetchFailedOnReconnect';

// N12 (2026-10-30): after an offline start, failed queries must load again
// once the network is back — and only those, not every query on screen.
describe('failedQuery', () => {
  it('picks the queries whose last load failed', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await client.fetchQuery({ queryKey: ['ok'], queryFn: async () => 1 });
    await client
      .fetchQuery({ queryKey: ['down'], queryFn: async () => Promise.reject(new TypeError('Failed to fetch')) })
      .catch(() => {});
    const picked = client
      .getQueryCache()
      .findAll({ predicate: failedQuery })
      .map((q) => q.queryKey[0]);
    expect(picked).toEqual(['down']);
  });
});

// R2-AUTH-2 (2026-10-31): the order page's Retry reloads every failed query
// on screen, not only the session.
describe('refetchFailedQueries', () => {
  it('reloads every active failed query and leaves the good ones alone', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls: string[] = [];
    let up = false;
    const make = (name: string, fails: boolean) => {
      const observer = new QueryObserver(client, {
        queryKey: [name],
        queryFn: async () => {
          calls.push(name);
          if (fails && !up) throw new TypeError('Failed to fetch');
          return name;
        },
      });
      const unsubscribe = observer.subscribe(() => {});
      return unsubscribe;
    };
    const subs = [make('session', true), make('skus', true), make('categories', true), make('stores', false)];
    await new Promise((r) => setTimeout(r, 10));
    calls.length = 0;
    up = true;
    await refetchFailedQueries(client);
    expect(calls.sort()).toEqual(['categories', 'session', 'skus']);
    expect(client.getQueryData(['skus'])).toBe('skus');
    subs.forEach((u) => u());
  });
});
