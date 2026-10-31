/**
 * How many batches "今日 N 批" counts (design review U5, 2026-10-31).
 *
 * The first "+" on a new batch made the count jump from 2 to 3: the draft
 * being filled in was counted as a batch, and a store member took it for
 * one more order already sent. Only batches that were sent count — a
 * draft is listed in the sheet but is not "a batch today" yet. The server
 * already leaves out drafts with nothing in them (RE-ORD-5); a cached list
 * from before the last edit could still hold one, and it is not counted
 * either.
 */
export function sentBatchCount(batches: ReadonlyArray<{ status: string }> | undefined): number {
  return (batches ?? []).filter((b) => b.status !== 'draft').length;
}
