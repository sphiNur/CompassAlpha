/**
 * The history detail's breakdown: the run's lines and money, the lines
 * shown and the figures at the top, for the whole run or the store picked
 * (runs/lib/historyBreakdown.ts, review RUNWEB2-09).
 */
import { useMemo } from 'react';
import {
  historyBreakdownOf,
  historyHeadline,
  visibleHistoryRows,
  type HistoryDetail,
} from '../lib/historyBreakdown';

export function useHistoryBreakdown(
  data: HistoryDetail | undefined,
  selectedStoreId: string | null,
) {
  const breakdown = useMemo(() => (data ? historyBreakdownOf(data) : null), [data]);
  // A store the run no longer has (or that this reader may not see) is
  // no filter: the whole run shows.
  const activeStoreId =
    selectedStoreId && breakdown?.perStore.has(selectedStoreId) ? selectedStoreId : null;
  const rows = useMemo(
    () => (breakdown ? visibleHistoryRows(breakdown, activeStoreId) : []),
    [activeStoreId, breakdown],
  );
  const headline = useMemo(
    () => (breakdown ? historyHeadline(breakdown, activeStoreId, rows) : null),
    [activeStoreId, breakdown, rows],
  );
  return { breakdown, activeStoreId, rows, headline };
}
