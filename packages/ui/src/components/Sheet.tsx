import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../cn';

/**
 * Shared "how many sheets are currently open?" counter (M1.5,
 * 2026-05-06). Module-level singleton — JS modules are deduplicated
 * across all consumers, so this is the org-wide source of truth.
 *
 * Why: Telegram's WebApp BackButton APPENDS click handlers (not
 * replace). When a section frame and an open sheet both register
 * handlers, a single back-tap fires both — drilling the section up
 * AND closing the sheet at once. With this counter, the section
 * frame can disable its own BackButton hook while ANY sheet is open
 * (see useSheetCount in apps/web/hooks/useTelegram), letting the
 * sheet's BackButton wiring take over uncontested.
 *
 * We also wire the Telegram BackButton from inside Sheet itself so
 * every sheet — including ones we forget — gets close-on-back for
 * free. Sheet keeps its own dependency on the global `window.Telegram`
 * so the @compass/ui package stays free of an apps/web import.
 *
 * Stacked sheets (sheet-on-sheet, e.g. Transfer launched from Manage
 * member): all open sheets register their handlers; a back-tap fires
 * each, closing the entire stack at once. This matches the Telegram-
 * native "X closes the modal" mental model and avoids the hairier
 * "topmost only" book-keeping we'd otherwise need. If a future round
 * wants per-level back, replace `_count` with an actual array.
 */
let _sheetCount = 0;
const _sheetCountListeners = new Set<() => void>();
function _bumpSheetCount(delta: number): void {
  _sheetCount = Math.max(0, _sheetCount + delta);
  _sheetCountListeners.forEach((l) => l());
}
export function getSheetCount(): number {
  return _sheetCount;
}
export function subscribeSheetCount(listener: () => void): () => void {
  _sheetCountListeners.add(listener);
  return () => {
    _sheetCountListeners.delete(listener);
  };
}

/**
 * Convenience hook for consumers — the counter as React state. Used
 * by SectionFrame to disable its own BackButton hook while sheets are
 * stacked on top.
 */
export function useSheetCount(): number {
  const [n, setN] = useState(_sheetCount);
  useEffect(
    () => subscribeSheetCount(() => setN(_sheetCount)),
    [],
  );
  return n;
}

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /**
   * Suppress Radix Dialog's default first-focusable autofocus
   * entirely. User taps to focus.
   *
   * Use when the sheet has multiple equal-priority interactive
   * elements (e.g. ConfirmPage's issue sheet has a note input AND a
   * photo button — the receiver may want either first; auto-focusing
   * the input forces them to dismiss the keyboard to reach the photo).
   */
  disableAutoFocus?: boolean;

  /**
   * Defer Radix's autofocus by N ms after open. Pass 280 (slightly
   * longer than slideUp's 240ms `--t-base`) so the keyboard pops
   * AFTER the sheet has reached its final position — eliminating
   * the iOS WebView scroll-jump that hides the bottom Save button.
   *
   * Use when the sheet has ONE primary input the user almost
   * certainly wants to type into (e.g. ApprovalPage's reject-reason
   * sheet). Better a11y than `disableAutoFocus` because focus
   * eventually does land in the dialog for keyboard / screen-reader
   * users on non-iOS envs.
   *
   * Mutually exclusive with `disableAutoFocus`; the latter wins.
   */
  deferAutoFocusMs?: number;
}

export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  disableAutoFocus = false,
  deferAutoFocusMs,
}: SheetProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Deferred-focus implementation: when `deferAutoFocusMs` is set, we
  // preventDefault on Radix's onOpenAutoFocus (so it doesn't fire
  // immediately during slideUp), then setTimeout to find the first
  // focusable inside the dialog and focus it ourselves. After
  // slideUp completes (240ms), the sheet is in final position; the
  // keyboard pops without scroll-jumping the WebView.
  useEffect(() => {
    if (!open || disableAutoFocus || !deferAutoFocusMs) return;
    const timer = setTimeout(() => {
      const root = contentRef.current;
      if (!root) return;
      // Match Radix's "first focusable" definition: input/textarea/
      // select/button/[tabindex]:not([tabindex="-1"]). Skip elements
      // inside [data-radix-focus-guard] which Radix injects.
      const candidates = root.querySelectorAll<HTMLElement>(
        'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      for (const el of candidates) {
        if (el.closest('[data-radix-focus-guard]')) continue;
        el.focus();
        // If the focused element is a text input, move caret to end
        // (the user is likely about to type, and a selected default
        // value would be clobbered by their first keystroke if the
        // input has any pre-filled content).
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          try {
            const len = el.value.length;
            el.setSelectionRange(len, len);
          } catch {
            /* setSelectionRange throws on number/email/etc inputs; ignore */
          }
        }
        break;
      }
    }, deferAutoFocusMs);
    return () => clearTimeout(timer);
  }, [open, disableAutoFocus, deferAutoFocusMs]);
  // Track open-state in the global counter + wire Telegram BackButton
  // to close. Skipped when not in Telegram (web preview just ignores).
  useEffect(() => {
    if (!open) return;
    _bumpSheetCount(1);
    // Read window.Telegram lazily — the package must not assume the
    // SDK is loaded (it ships even in non-Telegram contexts like
    // jest, storybook, the bare web preview).
    type TgBackButton = {
      onClick: (cb: () => void) => unknown;
      offClick: (cb: () => void) => unknown;
    };
    const tg =
      typeof window !== 'undefined'
        ? ((window as { Telegram?: { WebApp?: { BackButton?: TgBackButton } } }).Telegram?.WebApp ??
          null)
        : null;
    const handler = () => onOpenChange(false);
    if (tg?.BackButton) tg.BackButton.onClick(handler);
    return () => {
      _bumpSheetCount(-1);
      if (tg?.BackButton) tg.BackButton.offClick(handler);
    };
  }, [open, onOpenChange]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-[var(--c-scrim)]',
            'data-[state=open]:animate-[fadeIn_var(--t-quick)_var(--easing)]',
            'data-[state=closed]:animate-[fadeOut_var(--t-quick)_var(--easing)]',
          )}
        />
        <Dialog.Content
          ref={contentRef}
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 mx-auto flex w-full max-w-[var(--app-sheet-max-w)] flex-col',
            'rounded-t-[var(--r-sheet)] bg-[var(--c-surface)] text-[var(--c-fg)]',
            'data-[state=open]:animate-[slideUp_var(--t-base)_var(--easing)]',
            'data-[state=closed]:animate-[slideDown_var(--t-quick)_var(--easing)]',
            'pb-[var(--app-safe-bottom)] outline-none shadow-[var(--shadow-product)] ring-hairline',
          )}
          style={{
            maxHeight:
              'min(calc(90dvh - var(--app-safe-top)), calc(var(--app-viewport-h) - var(--app-safe-top) - 8px))',
          }}
          aria-describedby={description ? 'sheet-desc' : undefined}
          onOpenAutoFocus={
            disableAutoFocus || deferAutoFocusMs
              ? (e) => e.preventDefault()
              : undefined
          }
        >
          <SheetHeader>
            {/* Drag handle — wider than the old 40px hairline so
                first-time users read "draggable" without an explicit
                Cancel button (2026-05-04). Capsule pass snapped its
                height from the off-grid 5px to h-1 (4px). */}
            <div
              className="mx-auto h-1 w-12 rounded-full bg-[var(--c-fg-muted)] opacity-40"
              aria-hidden
            />
            {title ? (
              <Dialog.Title className="mt-3 text-center text-h2 font-semibold">
                {title}
              </Dialog.Title>
            ) : null}
            {description ? (
              <Dialog.Description id="sheet-desc" className="mt-1 text-center text-body-sm text-[var(--c-fg-muted)]">
                {description}
              </Dialog.Description>
            ) : null}
          </SheetHeader>
          <SheetBody>{children}</SheetBody>
          {footer ? <SheetFooter>{footer}</SheetFooter> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function SheetHeader({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-[var(--app-inline-x)] pt-3 pb-2', className)}>{children}</div>;
}

export function SheetBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'min-h-0 flex-1 overflow-y-auto overscroll-contain px-[var(--app-inline-x)] pb-4',
        className,
      )}
      data-scroll-locked
    >
      {children}
    </div>
  );
}

export function SheetFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        // M3.15 (2026-05-16): pt-3 / pb-4 → pt-2 / pb-3. The footer
        // CTA inside now reads as a peer of the bottom nav rather than
        // a separate "primary CTA bar" with its own breathing room.
        'sticky bottom-0 mt-auto bg-[var(--c-surface)] px-4 pb-3 pt-2',
        'px-[var(--app-inline-x)]',
        'border-t border-[var(--c-divider)]',
        className,
      )}
    >
      {children}
    </div>
  );
}
