/**
 * ConfirmPage pure logic (2026-10-21, CA-04 / CA-06). Kept out of the
 * component so the two rules that decide WHAT a receiver signs for are
 * unit-tested.
 */
import type { CatalogKey } from '@compass/i18n';
import { readDecimalText } from '@compass/ui';

export type ConfirmDecisionStatus = 'ok' | 'short' | 'wrong' | 'quality';

/** The verdicts a delivered line can get, in the order the chips show them. */
export const DECISIONS: readonly ConfirmDecisionStatus[] = ['ok', 'short', 'wrong', 'quality'];

/** M1.9-fix (2026-05-07): each verdict's words; the chips showed the raw enum. */
export const DECISION_LABEL = {
  ok: 'confirm.status.ok',
  short: 'confirm.status.short',
  wrong: 'confirm.status.wrong',
  quality: 'confirm.status.quality',
} as const satisfies Record<ConfirmDecisionStatus, CatalogKey>;

type DeliveringRunRow = {
  id: string;
  status: string;
  runDate: string;
  runIndex: number;
  storeTotals?: ReadonlyArray<{ storeId: string; itemCount: number }>;
  /** DX-DLV-13 (2026-11-01): the visible stores the run serves. */
  storeIds?: readonly string[];
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
  const mine = delivering.filter(
    (r) =>
      (r.storeTotals ?? []).some((st) => st.storeId === storeId && st.itemCount > 0) ||
      // DX-DLV-13: a run serving this store whose goods were all not found
      // still belongs here — the store sees them as 没买到.
      (r.storeIds ?? []).includes(storeId),
  );
  if (mine.length > 0) return mine;
  // A server that names the stores said this one is not served.
  if (delivering.some((r) => r.storeIds !== undefined)) return [];
  return delivering.slice(0, 1);
}

/**
 * DX-DLV-13 (2026-11-01): what the receiving page says when there is no
 * list to check. It used to say "nothing to receive" in every case.
 *   - 'recalled' — the purchaser took the delivery back; wait for it again;
 *   - 'onTheWay' — a delivering run serves this store, not handed over yet;
 *   - 'buying'   — a run serving this store is still being bought;
 *   - 'nothing'  — no run is bringing anything here.
 */
export type ReceivingWait = 'recalled' | 'onTheWay' | 'buying' | 'nothing';

export function receivingWait(input: {
  storeId: string;
  runs: ReadonlyArray<{ status: string; storeIds?: readonly string[] }>;
  /** The delivering run on screen, when there is one. */
  active: { recalledStoreIds?: readonly string[] } | null;
}): ReceivingWait {
  if (input.active) {
    return (input.active.recalledStoreIds ?? []).includes(input.storeId) ? 'recalled' : 'onTheWay';
  }
  const buying = input.runs.some(
    (r) =>
      (r.status === 'planned' || r.status === 'purchasing') &&
      (r.storeIds ?? []).includes(input.storeId),
  );
  return buying ? 'buying' : 'nothing';
}

/**
 * DX-DLV-13: products the purchaser did not find for this store — on the
 * run as `unavailable`, with this store's demand — listed as 没买到 so the
 * store knows they are not coming.
 */
export function unboughtForStore<
  T extends { skuId: string; status: string; unavailableNote?: string | null },
>(
  items: readonly T[],
  perStoreDemand: ReadonlyArray<{ storeId: string; skuId: string; qty: string }>,
  storeId: string,
): Array<T & { orderedQty: string }> {
  const demand = new Map(
    perStoreDemand.filter((d) => d.storeId === storeId).map((d) => [d.skuId, d.qty]),
  );
  return items
    .filter((it) => it.status === 'unavailable' && demand.has(it.skuId))
    .map((it) => ({ ...it, orderedQty: demand.get(it.skuId)! }));
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

export type ReceivedQtyProblem = 'required' | 'invalid' | 'tooPrecise' | 'exceeds' | 'notShort';

export type ReceivedQtyCheck =
  | { ok: true; value: string | null }
  | { ok: false; reason: ReceivedQtyProblem };

/**
 * The line under the received-quantity field (DX-DLV-07), by problem. Each
 * may use `{max}`, the quantity delivered. Review CONF-07: it was a
 * five-deep ternary in the page.
 */
export const RECEIVED_QTY_MESSAGE = {
  required: 'confirm.issue.receivedQtyRequired',
  notShort: 'confirm.issue.receivedQtyNotShort',
  invalid: 'confirm.issue.receivedQtyNotNumber',
  tooPrecise: 'confirm.issue.receivedQtyTooPrecise',
  exceeds: 'confirm.issue.receivedQtyRange',
} as const satisfies Record<ReceivedQtyProblem, CatalogKey>;

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
  // DX-DLV-07 (2026-11-01): "not a number" and "too many decimals" are
  // different mistakes; one sentence ("0 to 10") covered both.
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return { ok: false, reason: 'invalid' };
  if (!/^\d+(\.\d{1,3})?$/.test(trimmed)) return { ok: false, reason: 'tooPrecise' };
  if (Number(trimmed) - Number(splitQty) > 1e-6) return { ok: false, reason: 'exceeds' };
  // DLV-12: all of it arrived — that is "ok", not "short".
  if (status === 'short' && Number(splitQty) - Number(trimmed) <= 1e-6) {
    return { ok: false, reason: 'notShort' };
  }
  return { ok: true, value: trimmed };
}

const trimZeros = (q: string) => (q.includes('.') ? q.replace(/\.?0+$/, '') : q);

/**
 * Initial value of the received-qty input when the issue sheet opens.
 *
 * 2026-11-05 (owner): a wrong or damaged line now starts at the quantity
 * delivered, not 0. It usually did arrive, just with a problem, and 0
 * as the default booked stock the store had on the shelf as missing.
 * The receiver lowers it when part of it is unusable. A short line
 * still starts empty: how much came must be typed.
 */
export function initialReceivedQty(
  status: ConfirmDecisionStatus,
  existing: string | null | undefined,
  delivered?: string | null,
): string {
  // DX-DLV-07: the server keeps 3 decimals; "5.000" reads as 5.
  if (existing != null) return trimZeros(existing);
  if (status === 'wrong' || status === 'quality') return delivered ? trimZeros(delivered) : '0';
  return '';
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

/** The fields of the problem form that its checks read. */
export interface IssueFormFields {
  status: ConfirmDecisionStatus;
  /** 2026-10-21 CA-06: this store's split qty, the received-qty ceiling. */
  splitQty: string;
  note: string;
  received: string;
  receivedTouched: boolean;
  saveTried: boolean;
}

export interface IssueFormCheck {
  received: ReceivedQtyCheck;
  /**
   * The received-quantity problem to show. DX-DLV-07 (2026-11-01): only
   * once the field was typed into or left, or Save was tried — not the
   * moment the form opens.
   */
  shownReceivedProblem: ReceivedQtyProblem | null;
  noteMissing: boolean;
  /** The note's "required" line shows once Save was tried. */
  noteMissingShown: boolean;
  canSave: boolean;
  waitingForPhoto: boolean;
  /** DX-DLV-07: why Save is grey, said next to it instead of a dead button. */
  saveBlockedBy: 'photo' | 'note' | null;
}

/** Whether the problem form may be saved, and what it says when not. */
export function issueFormCheck(
  form: IssueFormFields,
  q: { photoUploading: boolean; saving: boolean },
): IssueFormCheck {
  const received = checkReceivedQty(form.status, form.received, form.splitQty);
  const noteMissing = form.note.trim().length === 0;
  const save = issueSaveState({
    reasonOk: !noteMissing && received.ok,
    photoUploading: q.photoUploading,
    saving: q.saving,
  });
  return {
    received,
    shownReceivedProblem:
      !received.ok && (form.receivedTouched || form.saveTried) ? received.reason : null,
    noteMissing,
    noteMissingShown: noteMissing && form.saveTried,
    canSave: save.canSave,
    waitingForPhoto: save.waitingForPhoto,
    saveBlockedBy: save.waitingForPhoto ? 'photo' : noteMissing ? 'note' : null,
  };
}

/** A verdict on one delivered line, as run.confirmStoreItem takes it. */
export interface ItemVerdict {
  runId: string;
  skuId: string;
  storeId: string;
  status: ConfirmDecisionStatus;
  note: string | null;
  photoUrl: string | null;
  receivedQty?: string | null;
}

type LineKey = { runId: string; skuId: string; storeId: string };

/** Whether `a` and `b` name the same delivered line. */
export function sameLine(a: LineKey, b: LineKey): boolean {
  return a.runId === b.runId && a.skuId === b.skuId && a.storeId === b.storeId;
}

/**
 * The run's splits with one line's verdict in place, shown before the
 * server answers. A tap on 正常 used to change nothing for ~400 ms (the
 * CN ↔ Tashkent round trip), so people tapped again and the server
 * appended four identical StoreItemConfirmed events. A refusal refetches
 * the truth.
 */
export function withLineVerdict<S extends LineKey>(
  splits: readonly S[],
  verdict: ItemVerdict,
): S[] {
  return splits.map((split) =>
    sameLine(split, verdict)
      ? {
          ...split,
          confirmStatus: verdict.status,
          confirmNote: verdict.note,
          confirmPhotoUrl: verdict.photoUrl,
          confirmReceivedQty: verdict.receivedQty ?? null,
        }
      : split,
  );
}

export interface ConfirmMainButtonState {
  /** The problem form, when it is open. */
  issue: { canSave: boolean; waitingForPhoto: boolean } | null;
  /** U4 (2026-10-31): the summary sheet before 确认收货. */
  finalOpen: boolean;
  confirming: boolean;
  markingAll: boolean;
  hasRun: boolean;
  lineCount: number;
  undecided: number;
  storeConfirmed: boolean;
}

export interface ConfirmMainButton {
  action: 'saveIssue' | 'submitConfirm' | 'openConfirm';
  label: { key: CatalogKey; vars?: Record<string, number> };
  visible: boolean;
  active: boolean;
}

/**
 * The page's main button. The open problem form drives its Save; the
 * summary sheet drives 确认收货; otherwise it opens that sheet.
 *
 * 2026-07-30: when lines are still undecided it SAYS so on the button
 * instead of showing an inert "确认收货"; the gate used to be invisible
 * and never actually shut.
 */
export function confirmMainButton(s: ConfirmMainButtonState): ConfirmMainButton {
  const allDecided = s.lineCount > 0 && s.undecided === 0;
  if (s.issue) {
    return {
      action: 'saveIssue',
      label: { key: s.issue.waitingForPhoto ? 'photo.uploading' : 'confirm.issue.save' },
      visible: true,
      active: s.issue.canSave,
    };
  }
  if (s.finalOpen) {
    return {
      action: 'submitConfirm',
      label: { key: s.confirming ? 'confirm.confirmingHint' : 'confirm.final.submit' },
      visible: true,
      active: allDecided && !s.storeConfirmed && !s.confirming,
    };
  }
  return {
    action: 'openConfirm',
    label: s.storeConfirmed
      ? { key: 'confirm.confirmStoreFinal' }
      : s.confirming
        ? { key: 'confirm.confirmingHint' }
        : allDecided
          ? { key: 'confirm.confirmStore' }
          : { key: 'confirm.confirmStoreBlocked', vars: { n: s.undecided } },
    visible: s.hasRun && s.lineCount > 0 && !s.storeConfirmed,
    active: allDecided && !s.confirming && !s.markingAll,
  };
}
