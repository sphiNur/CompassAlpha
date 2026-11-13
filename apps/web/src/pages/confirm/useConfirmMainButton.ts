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
  usePageMainButton(i18n.t(button.label.key, button.label.vars), actions[button.action], {
    visible: button.visible,
    active: button.active,
  });
}
