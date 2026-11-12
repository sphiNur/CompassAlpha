/**
 * The typed confirmations of the maintenance purges. What a purge deletes
 * is counted by kind with purgeCountsByKind, from @compass/contracts/limits
 * (review ADM2-34, 2026-11-12: the table map was here, in the web alone).
 */

/**
 * CMP-OPS-5 (2026-10-31): resetting a day deleted on one tap (307 rows in
 * one test). Like the full wipe, it now waits until the date being reset
 * is typed.
 * DX-CAT-4 (2026-11-01): only the digits are compared, in the date's own
 * order, so "20261030" and "2026/10/30" confirm 2026-10-30. The field
 * opened the iPhone number pad, which has no "-", and "2026-10-30" was
 * the only accepted form — the reset could not be confirmed on a phone.
 */
export function resetConfirmMatches(typed: string, date: string): boolean {
  const digits = date.replace(/\D/g, '');
  return digits !== '' && typed.replace(/\D/g, '') === digits;
}

/**
 * DX-CAT-17 (2026-11-01): the full wipe is confirmed by typing the
 * workspace's name — the one the person sees on the workspace page —
 * not its hidden slug ("default"), which was also printed in the
 * placeholder. Spaces around it don't matter.
 */
export function wipeConfirmMatches(typed: string, workspaceName: string): boolean {
  const name = workspaceName.trim();
  return name !== '' && typed.trim() === name;
}
