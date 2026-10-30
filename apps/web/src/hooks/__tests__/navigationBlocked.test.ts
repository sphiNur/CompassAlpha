import { describe, expect, it } from 'bun:test';
import { MutationCache, QueryClient } from '@tanstack/react-query';

import { BLOCKS_NAVIGATION, blocksNavigation } from '../useAppMutating';

// F3 (2026-10-30): every write used to lock the bottom nav. Only writes that
// swap the session (switch / create workspace) may hold it now.
describe('blocksNavigation', () => {
  it('an ordinary write does not hold the nav', () => {
    expect(blocksNavigation({ options: {} })).toBe(false);
    expect(blocksNavigation({ options: { meta: { other: true } } })).toBe(false);
  });

  it('a write marked BLOCKS_NAVIGATION does', () => {
    expect(blocksNavigation({ options: { meta: BLOCKS_NAVIGATION } })).toBe(true);
  });

  it('counts only the marked writes in flight', async () => {
    const client = new QueryClient({ mutationCache: new MutationCache() });
    const never = () => new Promise<never>(() => {});
    const cache = client.getMutationCache();
    void cache.build(client, { mutationFn: never }).execute(undefined);
    expect(client.isMutating({ predicate: blocksNavigation })).toBe(0);
    void cache.build(client, { mutationFn: never, meta: BLOCKS_NAVIGATION }).execute(undefined);
    expect(client.isMutating({ predicate: blocksNavigation })).toBe(1);
    expect(client.isMutating()).toBe(2);
  });
});
