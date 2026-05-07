import type { ReactNode } from 'react';
import { Banner } from './Banner';
import { Button } from './Button';
import { Input } from './Input';
import { Sheet } from './Sheet';

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
  /** Label for the secondary cancel button. Defaults to "Cancel". */
  cancelLabel?: ReactNode;
  /** Color treatment of the primary action. `danger` = red. */
  danger?: boolean;
  /** When true, a free-text reason input is shown and submit is gated
   *  on it being non-empty. Reason is passed back via `onConfirm`. */
  requireReason?: boolean;
  reasonPlaceholder?: string;
  reasonLabel?: ReactNode;
  /** Pending state — disables both buttons + spins the primary. */
  pending?: boolean;
  /** When `requireReason`, the controlled reason value. */
  reason?: string;
  onReasonChange?: (s: string) => void;
  /** Inside Telegram, the page MainButton drives the primary action;
   *  this hides the in-sheet primary button. Defaults true so the
   *  sheet renders cleanly outside Telegram. */
  showPrimaryInSheet?: boolean;
  /** Show an explicit Cancel button. Defaults to false because three
   *  dismiss paths (backdrop tap, swipe-down, Telegram BackButton) make
   *  a fourth redundant on mobile. We force-show it when there is a
   *  reason input — the soft keyboard covers the backdrop and the user
   *  needs an explicit "back out" target. Pass true to override e.g.
   *  for desktop-only flows. */
  showCancelInSheet?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
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
 * buttons. Inside Telegram, the parent page typically binds the
 * primary action to MainButton and sets `showPrimaryInSheet={false}`
 * so only the Cancel button shows in the sheet (avoiding the
 * "two-buttons-stacked" UX the user reported).
 */
export function ConfirmSheet({
  open,
  title,
  body,
  banner,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger,
  requireReason,
  reasonPlaceholder,
  reasonLabel,
  pending,
  reason = '',
  onReasonChange,
  showPrimaryInSheet = true,
  showCancelInSheet,
  onConfirm,
  onCancel,
}: ConfirmSheetProps) {
  const reasonOk = !requireReason || reason.trim().length > 0;
  // Cancel is force-shown when there's a reason input (keyboard covers
  // the backdrop) OR when the consumer explicitly opts in. Otherwise we
  // rely on tap-outside / swipe-down / Telegram BackButton.
  const showCancel = showCancelInSheet ?? !!requireReason;
  const hasFooter = showPrimaryInSheet || showCancel;
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onCancel()}
      title={title}
      footer={
        hasFooter ? (
          <div className="flex flex-col gap-2">
            {showPrimaryInSheet ? (
              <Button
                block
                variant={danger ? 'danger' : undefined}
                loading={pending}
                disabled={!reasonOk || pending}
                onClick={onConfirm}
              >
                {confirmLabel}
              </Button>
            ) : null}
            {showCancel ? (
              <Button block variant="pearl" onClick={onCancel} disabled={pending}>
                {cancelLabel}
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3 py-3">
        {banner}
        {body ? (
          <p className="whitespace-pre-line text-body leading-snug text-[var(--c-fg-muted)]">
            {body}
          </p>
        ) : null}
        {requireReason ? (
          <label className="block text-label font-semibold text-[var(--c-fg-muted)]">
            {reasonLabel ?? 'Reason'}
            <Input
              className="mt-1"
              value={reason}
              onChange={(e) => onReasonChange?.(e.target.value)}
              placeholder={reasonPlaceholder}
              autoFocus
            />
          </label>
        ) : null}
      </div>
    </Sheet>
  );
}

/** Re-export Banner for convenience — confirm sheets often want
 *  a banner at the top (e.g. summary) and including it from `@compass/ui`
 *  keeps the import paths clean. */
export { Banner };
