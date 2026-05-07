import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState, type ReactNode } from 'react';
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
   * When true, suppress Radix Dialog's default behavior of focusing
   * the first focusable child on open. The user taps an input to
   * focus it themselves.
   *
   * Why: on iOS Telegram WebView, focusing an input pops the virtual
   * keyboard instantly. If that happens DURING the slideUp animation,
   * the WebView scroll-jumps the page and often hides the sheet's
   * bottom Save button. Setting `disableAutoFocus` is the most
   * pragmatic fix for sheets that have a text input as the first
   * focusable element. (Audit M1.9, 2026-05-07.)
   *
   * Trade-off: keyboard-only / screen-reader users on non-Telegram
   * envs lose the "tab lands inside the dialog" affordance. Future
   * iteration can defer-focus with a setTimeout matching the slideUp
   * duration; for now, opt-in per sheet is the safe default.
   */
  disableAutoFocus?: boolean;
}

export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  disableAutoFocus = false,
}: SheetProps) {
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
            'fixed inset-0 z-50 bg-[oklch(0%_0_0_/_0.32)]',
            'data-[state=open]:animate-[fadeIn_var(--t-quick)_var(--easing)]',
            'data-[state=closed]:animate-[fadeOut_var(--t-quick)_var(--easing)]',
          )}
        />
        <Dialog.Content
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 flex flex-col',
            'rounded-t-[24px] bg-[var(--c-surface)] text-[var(--c-fg)]',
            'data-[state=open]:animate-[slideUp_var(--t-base)_var(--easing)]',
            'data-[state=closed]:animate-[slideDown_var(--t-quick)_var(--easing)]',
            'max-h-[calc(90dvh-var(--app-safe-top))]',
            'pb-[var(--app-safe-bottom)] outline-none',
          )}
          aria-describedby={description ? 'sheet-desc' : undefined}
          onOpenAutoFocus={
            disableAutoFocus ? (e) => e.preventDefault() : undefined
          }
        >
          <SheetHeader>
            {/* Drag handle — slightly bolder + wider than the previous
                40×4 hairline so first-time users can read it as "this is
                draggable" without us having to render an explicit Cancel
                button (2026-05-04). It's still subtle enough to not steal
                attention from the title. */}
            <div
              className="mx-auto h-[5px] w-12 rounded-full bg-[var(--c-fg-muted)] opacity-40"
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
  return <div className={cn('px-4 pt-3 pb-2', className)}>{children}</div>;
}

export function SheetBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex-1 overflow-y-auto px-4 pb-4', className)} data-scroll-locked>
      {children}
    </div>
  );
}

export function SheetFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'sticky bottom-0 mt-auto bg-[var(--c-surface)] px-4 pb-4 pt-3',
        'border-t border-[var(--c-divider)]',
        className,
      )}
    >
      {children}
    </div>
  );
}
