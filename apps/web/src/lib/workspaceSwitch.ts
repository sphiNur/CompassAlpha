import type { Tab } from '../stores/navStore';

/**
 * DX-SHL-3 (2026-11-01): switching workspace replaces every page, so the
 * pages' unsaved-draft guards (daily close) may veto it, like a tab or
 * store change does. After the switch the shell lands on the order tab
 * with the new workspace's first store, which is what the guards are
 * asked about. The settings sheet's workspace list calls it; it lived in
 * SettingsSheet.tsx until review TEST3-13.
 *
 * D7 (2026-11-13): it asks first only when writes are still waiting to be
 * sent (COREWEB2-03: they stay with this workspace). With nothing waiting
 * and no draft, the switch happens on the tap; a draft is the guards'
 * question.
 */
export async function mayLeaveWorkspace(deps: {
  waitingWrites: () => Promise<number>;
  confirmWaiting: (n: number) => Promise<boolean>;
  requestTabChange: (next: Tab) => Promise<boolean>;
  requestStoreChange: (next: null) => Promise<boolean>;
}): Promise<boolean> {
  const waiting = await deps.waitingWrites();
  if (waiting > 0 && !(await deps.confirmWaiting(waiting))) return false;
  if (!(await deps.requestTabChange('order'))) return false;
  return deps.requestStoreChange(null);
}
