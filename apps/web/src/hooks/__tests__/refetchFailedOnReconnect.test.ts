import { describe, expect, it } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';

import { failedQuery } from '../useRefetchFailedOnReconnect';

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
