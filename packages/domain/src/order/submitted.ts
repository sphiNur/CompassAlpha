/**
 * The order as it was submitted (2026-11-05).
 *
 * A reviewer's edits overwrite the lines in place (ItemAdjusted on the
 * contributor's row), so after review the read model only holds the
 * approved version. The owner needs both: what the store asked for and
 * what was approved. The event log still has every step, so the submitted
 * version is the state folded up to the LAST `Submitted` event (a
 * rejected order sent again is reviewed as its new submission).
 */
import { apply, emptyState, type OrderState } from './state';
import type { OrderEvent, SessionExtraItem } from './events';

export interface SubmittedSnapshot {
  /** seq of the Submitted event the snapshot was taken at. */
  seq: number;
  /** skuId → total qty across contributors, lines above 0 only. */
  totals: Map<string, number>;
  extras: SessionExtraItem[];
}

/** Null when the stream was never submitted or cannot be folded (a gap). */
export function submittedSnapshot(
  streamId: string,
  events: readonly OrderEvent[],
): SubmittedSnapshot | null {
  let state: OrderState = emptyState(streamId);
  let snap: SubmittedSnapshot | null = null;
  try {
    for (const e of events) {
      state = apply(state, e);
      if (e.type === 'Submitted') snap = snapshotOf(state);
    }
  } catch {
    return null;
  }
  return snap;
}

function snapshotOf(state: OrderState): SubmittedSnapshot {
  const totals = new Map<string, number>();
  for (const it of state.items.values()) {
    const q = Number(it.qty);
    if (q > 0) totals.set(it.skuId, (totals.get(it.skuId) ?? 0) + q);
  }
  return { seq: state.seq, totals, extras: state.extras.map((e) => ({ ...e })) };
}
