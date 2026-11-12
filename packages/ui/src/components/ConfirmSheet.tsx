import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from './Button';
import { Input } from './Input';
import { Field } from './Rows';
import { Sheet } from './Sheet';
import { useUiLabels } from '../labels';
import { useTapGuard } from '../useTapGuard';

export interface ConfirmSheetProps {
  open: boolean;
  /** Sheet title — usually a question ("Cancel run?"). */
  title: ReactNode;
  /** Body copy explaining consequences. Newlines preserved. */
  body?: ReactNode;
  /** Optional banner at the top of the body — e.g. summary stats. */
  banner?: ReactNode;
  /** Label of the primary action button. */
  confirmLabel: ReactNode;
  /** Label for the secondary cancel button. Defaults to the host's `cancel` label. */
  cancelLabel?: ReactNode;
  /** Color treatment of the primary action. `danger` = red. */
  danger?: boolean;
  /**
   * DX-IX-6 (2026-11-01): the action cannot be taken back by the person
   * (confirm receipt locks the store). Like `danger`, the sheet then
   * always shows Cancel and focuses it, so Enter-Enter from the opener
   * cannot run the action.
   */
  irreversible?: boolean;
  /** When true, a free-text reason input is shown and submit is gated
   *  on it being non-empty (the value is `reason`). */
  requireReason?: boolean;
  /**
   * M1.7-A / M1.13: a reason the person may give but need not (cancelling
   * a run). It sits behind a "+ Add note" link instead of opening the
   * keyboard, which invited "asdf"; the confirm does not wait for it.
   * `requireReason` wins.
   */
  reasonOptional?: boolean;
  reasonPlaceholder?: string;
  reasonLabel?: ReactNode;
  /**
   * Pending state: disables both buttons and spins the primary. The sheet
   * cannot be dismissed meanwhile (M3.10): a swipe mid-request cleared
   * the reason, and a failure then had nothing left to retry with.
   */
  pending?: boolean;
  /** With a reason field, the controlled reason value. */
  reason?: string;
  onReasonChange?: (s: string) => void;
  /** Show an explicit Cancel button. Defaults to false because three
   *  dismiss paths (backdrop tap, swipe-down, Telegram BackButton) make
   *  a fourth redundant on mobile. We force-show it when there is a
   *  reason input — the soft keyboard covers the backdrop and the user
   *  needs an explicit "back out" target. Pass true to override e.g.
   *  for desktop-only flows. */
  showCancelInSheet?: boolean;
  /** Open with focus on the cancel button (the safe answer), so a
   *  second Enter from the field that opened the sheet does not confirm
   *  it. Shows the cancel button. `danger` / `irreversible` imply it
   *  (confirmCancelPolicy). */
  focusCancel?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * DX-IX-6 (2026-11-01): a destructive or locking confirm always offers
 * Cancel and starts on it (the safe action, as for a native <dialog>), so
 * Enter on the opener followed by a repeated Enter cannot run it. Not when
 * a required reason keeps the confirm button disabled until typed: the
 * reason field takes focus there.
 */
export function confirmCancelPolicy(o: {
  danger?: boolean;
  irreversible?: boolean;
  requireReason?: boolean;
  showCancelInSheet?: boolean;
  /** The caller asks for it explicitly (the `focusCancel` prop). */
  focusCancel?: boolean;
}): { showCancel: boolean; focusCancel: boolean } {
  const guarded = !!(o.danger || o.irreversible);
  const focusCancel = (guarded && !o.requireReason) || !!o.focusCancel;
  return {
    // A Cancel the sheet starts on must be on screen.
    showCancel: guarded || focusCancel || (o.showCancelInSheet ?? !!o.requireReason),
    focusCancel,
  };
}

/**
 * The reason field (RUNWEB2-05). A required one is shown and takes the
 * focus; an optional one waits behind its link until `expanded`.
 */
export function confirmReasonPolicy(o: {
  requireReason?: boolean;
  reasonOptional?: boolean;
  expanded: boolean;
}): { showField: boolean; showToggle: boolean; autoFocus: boolean } {
  const required = !!o.requireReason;
  const optional = !required && !!o.reasonOptional;
  return {
    showField: required || (optional && o.expanded),
    showToggle: optional && !o.expanded,
    autoFocus: required,
  };
}

/**
 * Generic two-button confirmation sheet — promoted from `RunPage` so
 * any page can use the same look-and-feel. Used for:
 *
 *   - Reversal flows (cancel run, undo purchase, recall delivery, etc.)
 *   - Destructive admin actions
 *   - "Are you sure?" prompts that need an audit reason
 *
 * Pattern: title + body + optional reason input + primary/cancel
 * buttons. The sheet always carries its primary button: the page's main
 * button is under the sheet (M3.49). RunPage's own copy of this sheet,
 * which added the optional reason and the pending lock, is merged in
 * (review RUNWEB2-05).
 */
export function ConfirmSheet({
  open,
  title,
  body,
  banner,
  confirmLabel,
  cancelLabel,
  danger,
  irreversible,
  requireReason,
  reasonOptional,
  reasonPlaceholder,
  reasonLabel,
  pending,
  reason = '',
  onReasonChange,
  showCancelInSheet,
  focusCancel,
  onConfirm,
  onCancel,
}: ConfirmSheetProps) {
  const labels = useUiLabels();
  const reasonOk = !requireReason || reason.trim().length > 0;
  // DLV-4: a double tap sent two requests before `pending` disabled this.
  const guardTap = useTapGuard();
  // An optional reason opened once stays open until the sheet closes.
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!open) setExpanded(false);
  }, [open]);
  const field = confirmReasonPolicy({ requireReason, reasonOptional, expanded });
  // Cancel is force-shown when there's a reason input (keyboard covers
  // the backdrop) OR when the consumer explicitly opts in. Otherwise we
  // rely on tap-outside / swipe-down / Telegram BackButton.
  const { showCancel, focusCancel: startOnCancel } = confirmCancelPolicy({
    danger,
    irreversible,
    requireReason,
    showCancelInSheet: showCancelInSheet ?? (field.showField || undefined),
    focusCancel,
  });
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o && !pending) onCancel();
      }}
      title={title}
      footer={
        <div className="flex flex-col gap-2">
          <Button
            block
            variant={danger ? 'danger' : undefined}
            loading={pending}
            disabled={!reasonOk || pending}
            onClick={guardTap(onConfirm, String(confirmLabel ?? ''))}
          >
            {confirmLabel}
          </Button>
          {showCancel ? (
            <Button
              block
              variant="pearl"
              onClick={onCancel}
              disabled={pending}
              data-autofocus={startOnCancel || undefined}
            >
              {cancelLabel ?? labels.cancel}
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="flex flex-col gap-3 py-3">
        {banner}
        {body ? (
          <p className="whitespace-pre-line text-old-body leading-snug text-[var(--c-fg-muted)]">
            {body}
          </p>
        ) : null}
        {field.showField ? (
          <Field label={reasonLabel ?? labels.reason}>
            <Input
              value={reason}
              onChange={(e) => onReasonChange?.(e.target.value)}
              placeholder={reasonPlaceholder}
              autoFocus={field.autoFocus}
            />
          </Field>
        ) : null}
        {field.showToggle ? (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            // DX-VIS-6 (2026-11-01): was a 16px-tall tap target.
            className="hit-44 self-start py-1 text-old-label text-[var(--c-action)] active:opacity-70"
          >
            {labels.addNote}
          </button>
        ) : null}
      </div>
    </Sheet>
  );
}
