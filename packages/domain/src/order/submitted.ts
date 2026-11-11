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
import { milliQty, qtyTotalsBySku } from '@compass/contracts/quantity';
import { apply, emptyState, type OrderState } from './state';
import type { OrderEvent, SessionExtraItem } from './events';

export interface SubmittedSnapshot {
  /** seq of the Submitted event the snapshot was taken at. */
  seq: number;
  /** skuId → total qty across contributors ("2.5"), lines above 0 only. */
  totals: Map<string, string>;
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
  // Review QTY-01 (2026-11-11): exact, not float sums.
  const totals = new Map<string, string>();
  for (const [skuId, milli] of qtyTotalsBySku(state.items.values())) {
    totals.set(skuId, milliQty(milli));
  }
  return { seq: state.seq, totals, extras: state.extras.map((e) => ({ ...e })) };
}
