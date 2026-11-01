/**
 * DX-APR-1 (2026-11-01): which orders have a quantity change on its way.
 *
 * The +/- write lives in the expanded line list, the 通过 / 驳回 buttons
 * in the card above it. On a slow network a reviewer tapped + and then
 * 通过 200 ms later: the approval reached the server first, carrying the
 * version from before the change, and approved the old quantity (the
 * change then failed with "already approved"). The card now reads the
 * pending adjustItem writes from the mutation cache and holds 通过 /
 * 驳回 ("正在保存…") for those orders. The write counts as pending
 * until the order list has been refetched, so the approval that follows
 * carries the version that includes the reviewer's own change.
 */
export function adjustingSessionIds(variables: ReadonlyArray<unknown>): Set<string> {
  const ids = new Set<string>();
  for (const v of variables) {
    const sessionId = (v as { sessionId?: unknown } | null | undefined)?.sessionId;
    if (typeof sessionId === 'string') ids.add(sessionId);
  }
  return ids;
}
