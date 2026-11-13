/**
 * UX-07: `useConfirm()`, the in-app yes/no question. The context lives
 * apart from ConfirmProvider so Sheet can ask (discard unsaved changes?)
 * without importing ConfirmSheet, which imports Sheet.
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title, confirmLabel, danger: true }))) return;
 */
import { createContext, useContext } from 'react';
import { browserConfirm, type Confirm } from './confirmQueue';

export const ConfirmContext = createContext<Confirm | null>(null);

/** Asks through the nearest ConfirmProvider; the browser's confirm without one. */
export function useConfirm(): Confirm {
  return useContext(ConfirmContext) ?? browserConfirm;
}
