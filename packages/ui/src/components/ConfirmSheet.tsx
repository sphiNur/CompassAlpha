import type { ReactNode } from 'react';
import { Banner } from './Banner';
import { Button } from './Button';
import { Input } from './Input';
import { Sheet } from './Sheet';
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
  /** Label for the secondary cancel button. Defaults to "Cancel". */
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
 * reason field takes focus there. Shared with RunPage's confirm sheet.
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
  irreversible,
  requireReason,
  reasonPlaceholder,
  reasonLabel,
  pending,
  reason = '',
  onReasonChange,
  showPrimaryInSheet = true,
  showCancelInSheet,
  focusCancel,
  onConfirm,
  onCancel,
}: ConfirmSheetProps) {
  const reasonOk = !requireReason || reason.trim().length > 0;
  // DLV-4: a double tap sent two requests before `pending` disabled this.
  const guardTap = useTapGuard();
  // Cancel is force-shown when there's a reason input (keyboard covers
  // the backdrop) OR when the consumer explicitly opts in. Otherwise we
  // rely on tap-outside / swipe-down / Telegram BackButton.
  const { showCancel, focusCancel: startOnCancel } = confirmCancelPolicy({
    danger,
    irreversible,
    requireReason,
    showCancelInSheet,
    focusCancel,
  });
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
                onClick={guardTap(onConfirm, String(confirmLabel ?? ''))}
              >
                {confirmLabel}
              </Button>
            ) : null}
            {showCancel ? (
              <Button
                block
                variant="pearl"
                onClick={onCancel}
                disabled={pending}
                data-autofocus={startOnCancel || undefined}
              >
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
          <p className="whitespace-pre-line text-old-body leading-snug text-[var(--c-fg-muted)]">
            {body}
          </p>
        ) : null}
        {requireReason ? (
          <label className="block text-old-label font-semibold text-[var(--c-fg-muted)]">
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
