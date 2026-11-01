import { useEffect } from 'react';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { cacheOwner } from '../lib/queryPersist';
import { hintStorage, readRunHint } from '../lib/runHint';
import { savedTab } from '../app/pageChunks';

/**
 * DX-PFE-3 (2026-11-01): a purchaser who reopens the app on the purchase
 * tab waited for, in turn, the auth check, the saved-data restore, the
 * page chunk, `run.list` and only then `run.get`. Here both run queries
 * start at the first render of the app, side by side; the page finds
 * them in flight (or answered) with the same inputs it asks with, so
 * nothing is fetched twice. `run.get` needs the run's id before
 * `run.list` has answered, which lib/runHint remembers from last time.
 *
 * Only for the purchase tab, and only once per start.
 */
export function useWarmRunQueries(): void {
  const utils = trpc.useUtils();
  useEffect(() => {
    const session = useAuthStore.getState().session;
    if (!session?.permissions.includes('run.purchase')) return;
    const storage = hintStorage();
    if (!storage || savedTab(storage) !== 'run') return;
    void utils.run.list.prefetch();
    const runId = readRunHint(storage, cacheOwner(session));
    if (runId) void utils.run.get.prefetch({ runId });
  }, [utils]);
}
