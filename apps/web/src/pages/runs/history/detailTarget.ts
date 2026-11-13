/**
 * Which run the history detail sheet shows. The list, its day rows and
 * the day sheet all open it the same way (review RUNWEB2-09: each built
 * the target itself).
 */
import type { RunListRow } from '../types';

export interface HistoryDetailTarget {
  runId: string;
  runIndex: number;
  runDate: string;
  status: string;
  /** When a user opens a store from the history list, land directly on
   * that branch's daily purchase list instead of the combined run. */
  initialStoreId?: string | null;
}

/** A history row's run, opened on one store's lines when one is given. */
export function detailTargetOf(run: RunListRow, initialStoreId?: string): HistoryDetailTarget {
  return {
    runId: run.id,
    runIndex: run.runIndex,
    runDate: run.runDate,
    status: run.status,
    ...(initialStoreId ? { initialStoreId } : {}),
  };
}
