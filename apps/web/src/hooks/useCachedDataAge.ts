import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Query } from '@tanstack/react-query';

/**
 * When the oldest data on screen was loaded, or null when nothing on
 * screen has data. Exported for tests.
 */
export function oldestShownData(
  queries: ReadonlyArray<Pick<Query, 'state' | 'getObserversCount'>>,
): number | null {
  let oldest: number | null = null;
  for (const q of queries) {
    if (q.getObserversCount() === 0 || q.state.data === undefined) continue;
    const at = q.state.dataUpdatedAt;
    if (at > 0 && (oldest === null || at < oldest)) oldest = at;
  }
  return oldest;
}

/** "14:05" today, "10-30 14:05" on an earlier day (device time). */
export function lastUpdatedLabel(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const n = new Date(now);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay =
    d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  if (sameDay) return hhmm;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hhmm}`;
}

/**
 * R2-ENG-1 / R2-SHL-2 (2026-10-31): the offline banner said "you are
 * seeing the last loaded content" whether or not anything had loaded.
 * Offline, this tells Shell how old the data on screen is (the saved
 * copy keeps its original load time), or that there is none.
 */
export function useCachedDataAge(enabled: boolean): number | null {
  const queryClient = useQueryClient();
  const [oldest, setOldest] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const cache = queryClient.getQueryCache();
    const update = () => setOldest(oldestShownData(cache.getAll()));
    update();
    return cache.subscribe(update);
  }, [enabled, queryClient]);
  return enabled ? oldest : null;
}
