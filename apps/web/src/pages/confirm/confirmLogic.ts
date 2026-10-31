/**
 * ConfirmPage pure logic (2026-10-21, CA-04 / CA-06). Kept out of the
 * component so the two rules that decide WHAT a receiver signs for are
 * unit-tested.
 */
import { readDecimalText } from '@compass/ui';

export type ConfirmDecisionStatus = 'ok' | 'short' | 'wrong' | 'quality';

type DeliveringRunRow = {
  id: string;
  status: string;
  runDate: string;
  runIndex: number;
  storeTotals?: ReadonlyArray<{ storeId: string; itemCount: number }>;
};

/**
 * 2026-10-21 CA-04: several runs can be out for delivery at once now
 * (only one can be BUYING). Every delivering run that sent goods to this
 * store, oldest first — the oldest is the one that has been waiting
 * longest for a signature.
 *
 * `storeTotals` comes from run.list and counts purchased SKU splits per
 * visible store, so `itemCount > 0` means "this run has goods for me".
 * When none qualifies (e.g. a list row without storeTotals) the old
 * behaviour is kept: the first delivering run, so the page still shows
 * its "nothing for this store" state instead of a blank one.
 */
export function deliveringRunsForStore<T extends DeliveringRunRow>(
  runs: readonly T[],
  storeId: string | null,
): T[] {
  const delivering = runs
    .filter((r) => r.status === 'delivering')
    .sort((a, b) =>
      a.runDate === b.runDate ? a.runIndex - b.runIndex : a.runDate < b.runDate ? -1 : 1,
    );
  if (!storeId) return delivering.slice(0, 1);
  const mine = delivering.filter((r) =>
    (r.storeTotals ?? []).some((st) => st.storeId === storeId && st.itemCount > 0),
  );
  return mine.length > 0 ? mine : delivering.slice(0, 1);
}

/**
 * Which run the picker opens on: the oldest one this store has not yet
 * signed for. `storeConfirmed` maps runId → whether every delivered line
 * at this store is confirmed (undefined while that run is loading —
 * treated as "not confirmed" so the oldest still wins). Falls back to the
 * oldest run when the store has signed for all of them.
 */
export function defaultDeliveringRunId(
  candidates: ReadonlyArray<{ id: string }>,
  storeConfirmed: ReadonlyMap<string, boolean | undefined>,
): string | null {
  if (candidates.length === 0) return null;
  const open = candidates.find((c) => storeConfirmed.get(c.id) !== true);
  return (open ?? candidates[0]!).id;
}

export type ReceivedQtyCheck =
  | { ok: true; value: string | null }
  | { ok: false; reason: 'required' | 'invalid' | 'exceeds' | 'notShort' };

/**
 * 2026-10-21 CA-06: client mirror of the domain's receivedQty rule.
 * 'ok' sends nothing; 'short' must say how much arrived; 'wrong' /
 * 'quality' default to 0 when left empty. Always 0 ≤ qty ≤ split qty,
 * at most 3 decimals (the contract's precision).
 */
export function checkReceivedQty(
  status: ConfirmDecisionStatus,
  raw: string,
  splitQty: string,
): ReceivedQtyCheck {
  if (status === 'ok') return { ok: true, value: null };
  // R2-DLV-2 (2026-10-31): the same reading as every other number field
  // (readDecimalText): "1,000" is a thousand in Chinese and English, 1 in
  // Russian and Uzbek. A bare `replace(',', '.')` read it as 1 everywhere,
  // so a short line could be saved as 1 when a thousand was typed.
  const read = readDecimalText(raw);
  if (!read.ok) return { ok: false, reason: 'invalid' };
  const trimmed = read.value;
  if (trimmed === '') {
    return status === 'short' ? { ok: false, reason: 'required' } : { ok: true, value: '0' };
  }
  if (!/^\d+(\.\d{1,3})?$/.test(trimmed)) return { ok: false, reason: 'invalid' };
  if (Number(trimmed) - Number(splitQty) > 1e-6) return { ok: false, reason: 'exceeds' };
  // DLV-12: all of it arrived — that is "ok", not "short".
  if (status === 'short' && Number(splitQty) - Number(trimmed) <= 1e-6) {
    return { ok: false, reason: 'notShort' };
  }
  return { ok: true, value: trimmed };
}

/** Initial value of the received-qty input when the issue sheet opens. */
export function initialReceivedQty(
  status: ConfirmDecisionStatus,
  existing: string | null | undefined,
): string {
  if (existing != null) return existing;
  return status === 'wrong' || status === 'quality' ? '0' : '';
}

/**
 * 2026-10-21 FE-01 / F4-02: what the page shows for run.list.
 *   - 'loading' — first load in flight: a spinner, never "nothing to confirm".
 *   - 'error'   — failed with nothing cached: error + Retry. Showing the
 *                 empty state here made receivers on bad wifi think no
 *                 goods were coming and skip signing.
 *   - 'ready'   — data in hand. `stale` = a later refetch failed; the cached
 *                 runs stay usable (offline confirms queue against them) and
 *                 an error banner with Retry sits on top.
 */
export type RunsListView =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'offline' }
  | { kind: 'ready'; stale: boolean };
/**
 *   - 'offline' — R2-ENG-1 (2026-10-31): offline with no saved copy the
 *                 query waits (`waitingOffline` = fetchStatus 'paused')
 *                 instead of failing; it is not "nothing to confirm" and
 *                 loads by itself once back online.
 */
export function runsListView(q: {
  isLoading: boolean;
  isError: boolean;
  hasData: boolean;
  waitingOffline?: boolean;
}): RunsListView {
  if (q.hasData) return { kind: 'ready', stale: q.isError };
  if (q.waitingOffline) return { kind: 'offline' };
  if (q.isError) return { kind: 'error' };
  if (q.isLoading) return { kind: 'loading' };
  // Disabled / idle query with no data: treat as loaded-and-empty.
  return { kind: 'ready', stale: false };
}

/**
 * CMP-DLV-6 (2026-10-31): whether the issue sheet's Save may be pressed.
 * Saving while the photo was still uploading stored the decision without
 * it, and nothing said so; Save now waits for the upload, with the reason
 * shown.
 */
export function issueSaveState(q: {
  reasonOk: boolean;
  photoUploading: boolean;
  saving: boolean;
}): { canSave: boolean; waitingForPhoto: boolean } {
  return {
    canSave: q.reasonOk && !q.photoUploading && !q.saving,
    waitingForPhoto: q.photoUploading,
  };
}
