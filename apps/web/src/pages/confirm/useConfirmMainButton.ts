/**
 * The receiving page's main button (review CONF-07): which of the three
 * jobs it does, and its words, come from `confirmMainButton`.
 */
import { usePageMainButton } from '../../hooks/usePageMainButton';
import { useI18n } from '../../hooks/useI18n';
import { confirmMainButton, type ConfirmMainButtonState } from './confirmLogic';

export function useConfirmMainButton(
  state: ConfirmMainButtonState,
  actions: {
    /** Save the open problem form. */
    saveIssue: () => void;
    /** Send 确认收货 from the summary sheet. */
    submitConfirm: () => void;
    /** Open the summary sheet (U4). */
    openConfirm: () => void;
    /** UX-01: mark every line OK, then open the summary sheet. */
    markAllAndConfirm: () => void;
  },
): void {
  const i18n = useI18n();
  const button = confirmMainButton(state);
  const text = i18n.t(button.label.key, button.label.vars);
  // 2026-11-14 (owner): a circle with a check on the nav's row, its text
  // the accessible name. While lines are still to check it waits: their
  // count is its badge, and the hint over the row says it in words; so
  // does it while a problem's photo is still uploading.
  const blocked = button.label.key === 'confirm.confirmStoreBlocked';
  const waits = blocked || button.label.key === 'photo.uploading';
  usePageMainButton(text, actions[button.action], {
    visible: button.visible,
    active: button.active,
    icon: 'check',
    badge: blocked ? button.label.vars?.n : undefined,
    inactiveHint: waits ? text : undefined,
  });
}
