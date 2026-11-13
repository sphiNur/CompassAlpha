import type { Tab } from '../stores/navStore';

/**
 * DX-SHL-3 (2026-11-01): switching workspace replaces every page, so it
 * asks first and then lets the pages' unsaved-draft guards (daily close)
 * veto it, like a tab or store change does. After the switch the shell
 * lands on the order tab with the new workspace's first store, which is
 * what the guards are asked about. The settings sheet's workspace list
 * calls it; it lived in SettingsSheet.tsx until review TEST3-13.
 */
export async function mayLeaveWorkspace(deps: {
  confirm: () => Promise<boolean>;
  requestTabChange: (next: Tab) => Promise<boolean>;
  requestStoreChange: (next: null) => Promise<boolean>;
}): Promise<boolean> {
  if (!(await deps.confirm())) return false;
  if (!(await deps.requestTabChange('order'))) return false;
  return deps.requestStoreChange(null);
}
