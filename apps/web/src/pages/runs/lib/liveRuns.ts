/**
 * 2026-10-21 CA-04: several open runs per org.
 *
 * Migration 0047 narrowed the one-open-run index to planned/purchasing,
 * so an org can now have ONE run being planned/bought plus any number of
 * earlier runs still out for delivery / awaiting store confirmation. The
 * Run tab used to take "the first planned/purchasing/delivering run" —
 * which would now hide every other delivering run (and the new trip).
 *
 * `pickActiveRun` resolves which run the page shows:
 *   - an explicit choice from the run switcher, while it is still open;
 *   - `NEW_RUN` = the purchaser chose the "new purchase" preview, honoured
 *     only while no run is being bought (otherwise run.create would just
 *     hand back the buying run);
 *   - default: the amending run for amenders (so a reopened run never
 *     gets stuck), else the buying run, else the oldest delivering run.
 *
 * Pure; tests in __tests__/liveRuns.test.ts.
 */

export const NEW_RUN = 'new' as const;

export type LiveRunRow = {
  id: string;
  status: string;
  runDate: string;
  runIndex: number;
};

export function isBuying(status: string): boolean {
  return status === 'planned' || status === 'purchasing';
}

/** Open runs the switcher offers, oldest first (rows arrive newest first). */
export function liveRunsOf<R extends LiveRunRow>(rows: readonly R[], canAmend: boolean): R[] {
  return rows
    .filter(
      (r) =>
        isBuying(r.status) || r.status === 'delivering' || (canAmend && r.status === 'amending'),
    )
    .sort((a, b) =>
      a.runDate === b.runDate ? a.runIndex - b.runIndex : a.runDate < b.runDate ? -1 : 1,
    );
}

export function pickActiveRun<R extends LiveRunRow>(
  rows: readonly R[],
  opts: { canAmend: boolean; selectedKey: string | null },
): R | null {
  const live = liveRunsOf(rows, opts.canAmend);
  const buying = live.find((r) => isBuying(r.status)) ?? null;
  if (opts.selectedKey === NEW_RUN && !buying) return null;
  if (opts.selectedKey && opts.selectedKey !== NEW_RUN) {
    const chosen = live.find((r) => r.id === opts.selectedKey);
    if (chosen) return chosen;
  }
  if (opts.canAmend) {
    const amend = live.find((r) => r.status === 'amending');
    if (amend) return amend;
  }
  return buying ?? live.find((r) => r.status === 'delivering') ?? null;
}

/**
 * What the top of the purchase screen shows before it can decide between
 * "plan a new purchase" and the open run. P-2 (2026-10-31): while run.list
 * was still loading, `activeRun` was null and the screen fell through to
 * the planning branch; previewCreatable usually answers first, with no
 * sessions (they are already in the open run), so the buyer briefly read
 * "no approved orders to plan" — on a slow network it was the largest
 * paint. Loading now shows a placeholder instead.
 */
export type RunListGate = 'error' | 'offline' | 'loading' | 'ready';

export function runListGate(q: {
  data: unknown;
  isError: boolean;
  fetchStatus: string;
}): RunListGate {
  if (q.data !== undefined) return 'ready';
  if (q.isError) return 'error';
  if (q.fetchStatus === 'paused') return 'offline';
  return 'loading';
}
