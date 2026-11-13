/**
 * A toast with an Undo button, for actions that take effect at once and can
 * be taken back (archive in the catalog, delete a shift in attendance).
 *
 * D3 (2026-11-13): archiving no longer asks first; the toast's Undo takes it
 * back. UX-03 (2026-11-13): deleting a shift does the same.
 */
import { useToast } from '@compass/ui';
import { useI18n } from './useI18n';

/** How long the toast keeps its Undo button up. */
export const UNDO_TOAST_MS = 6000;

/** Shows `message` with an Undo button that runs `undo`. */
export function useUndoToast() {
  const toast = useToast();
  const i18n = useI18n();
  return (message: string, undo: () => void) =>
    toast.show(message, {
      tone: 'info',
      ttlMs: UNDO_TOAST_MS,
      actions: [{ label: i18n.t('common.undo'), onClick: undo }],
    });
}
