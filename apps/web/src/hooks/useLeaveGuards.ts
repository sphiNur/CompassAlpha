/**
 * Asks before leaving a form throws away what was typed: through the
 * shell's store chip, a bottom tab, or reloading or closing the browser.
 * Review CONF-06: moved out of SettlementPage.
 */
import { useEffect } from 'react';
import { registerStoreChangeGuard } from '../lib/storeContext';
import { registerTabChangeGuard, type Tab } from '../stores/navStore';
import { useStableCallbacks } from './useStableCallbacks';

export function useLeaveGuards({
  dirty,
  tab,
  storeId,
  saving,
  confirmLeave,
}: {
  /** There is typed input that leaving would throw away. */
  dirty: boolean;
  /** The page's own tab: choosing it again is not leaving. */
  tab: Tab;
  /** The store on screen: choosing it again is not leaving. */
  storeId: string | null;
  /** A save is on its way. Read when a tab is chosen. */
  saving: { readonly current: boolean };
  /** Asks whether the input may go: true to leave. */
  confirmLeave: () => Promise<boolean>;
}): void {
  const { ask } = useStableCallbacks({ ask: confirmLeave });
  // The store chip is global chrome, so it cannot know whether this form
  // is dirty. Register the same confirmation the page's own selector uses;
  // this prevents an org admin switching stores from silently losing it.
  useEffect(
    () =>
      registerStoreChangeGuard((nextStoreId) => {
        if (nextStoreId === storeId || !dirty) return true;
        return ask();
      }),
    [ask, dirty, storeId],
  );
  // The shell only renders the active bottom-tab page, so leaving the tab
  // unmounts the form. Ask the same way before that.
  useEffect(
    () =>
      registerTabChangeGuard((nextTab) => {
        // R2-CLS-2 (2026-10-31): a save already on its way finishes after
        // the page closes (its "saved" toast shows on the next tab), so
        // asking to "discard" it was false. Only unsent changes ask.
        if (nextTab === tab || !dirty || saving.current) return true;
        return ask();
      }),
    [ask, dirty, saving, tab],
  );
  // A reload or close is the only way out of a WebApp that does not go
  // through the shell. Browsers ask in their own words here; a custom
  // dialog is not allowed.
  useEffect(() => {
    if (!dirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [dirty]);
}
