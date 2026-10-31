/**
 * What an approval card's header shows next to the total (2026-10-31).
 *
 * CMP-APR-6: the cash / transfer split was shown whenever both strings
 * were truthy, and "0.00" is truthy, so an all-cash order read
 * "转账 ~0". The split only says something when both parts are above 0;
 * otherwise the total alone is the whole story.
 *
 * CMP-APR-7: one badge "备注 · 2" stood for both the note and the
 * off-catalog items, and the 2 was the item count. The card now names
 * each on its own: "2 项其他物品" and "备注".
 */
export function showPaymentSplit(
  cash: string | null | undefined,
  transfer: string | null | undefined,
): boolean {
  return Number(cash ?? 0) > 0 && Number(transfer ?? 0) > 0;
}

export function cardRequests(
  notes: string | null | undefined,
  extrasJson: unknown,
): { extras: number; hasNote: boolean } {
  return {
    extras: Array.isArray(extrasJson) ? extrasJson.length : 0,
    hasNote: typeof notes === 'string' && notes.trim() !== '',
  };
}
