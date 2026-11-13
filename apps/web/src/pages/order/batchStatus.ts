/**
 * What the order page asks of a batch's status (review ORD-10, step 2:
 * they lived in OrderPage, read by its hooks and views alike).
 */

/** Statuses where the batch is sent and no longer editable by its owner. */
export function isLockedStatus(status: string | null | undefined): boolean {
  return (
    status === 'submitted' || status === 'approved' || status === 'in_run' || status === 'archived'
  );
}

/**
 * ORD-4 (2026-10-30): a batch of the day a reviewer sent back, other than
 * the one on screen. Every view of the page says so, with a way to it.
 */
export function otherRejectedBatch<B extends { id: string; status: string }>(
  batches: readonly B[] | undefined,
  shownId: string | undefined,
): B | null {
  return (batches ?? []).find((b) => b.status === 'rejected' && b.id !== shownId) ?? null;
}
