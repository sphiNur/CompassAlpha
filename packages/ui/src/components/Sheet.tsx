import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { cn } from '../cn';
import { pushTelegramBackHandler } from '../telegramBackStack';
import { useUiLabels } from '../labels';
import { useSheetFocus } from '../sheetFocus';

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
 * member): 2026-10-21 audit CA-34 — the BackButton is now owned through
 * the stack in ../telegramBackStack, so a back-tap closes only the TOP
 * sheet and the button is actually shown while any sheet is open.
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

/**
 * What every sheet owes the rest of the app while it is open: a place in
 * the open-sheet count, and a Telegram BackButton that closes it. Shared
 * by this Sheet and the redesigned one in ../kit so the two can coexist.
 */
export function useSheetPresence(open: boolean, onOpenChange: (open: boolean) => void): void {
  // 2026-10-21 audit CA-34: the close callback lives in a ref so a parent
  // re-render (inline `onOpenChange`) doesn't re-register this sheet and
  // jump it above a child sheet in the BackButton stack.
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  // Track open-state in the global counter + own the Telegram BackButton
  // while open (shown, closes only the TOP sheet). Outside Telegram the
  // SDK button is absent or a no-op, so nothing visible changes.
  useEffect(() => {
    if (!open) return;
    _bumpSheetCount(1);
    const release = pushTelegramBackHandler(() => onOpenChangeRef.current(false));
    return () => {
      _bumpSheetCount(-1);
      release();
    };
  }, [open]);
}

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /**
   * Suppress Radix Dialog's default first-focusable autofocus: no field
   * is focused, so no keyboard rises. DX-IX-2 (2026-11-01): focus moves
   * to the sheet itself instead (it used to stay on the button behind
   * the sheet). User taps to focus a field.
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

  /**
   * CMP-INV-2 / CMP-BUY-4 / CMP-INT-2 (2026-10-31): the sheet holds input
   * the person has not saved. Esc, a backdrop tap and Telegram's back
   * button then ask "discard changes?" first instead of throwing the
   * input away. Buttons inside the sheet that close it on purpose (Save,
   * Cancel) call `onOpenChange(false)` themselves and are not asked.
   */
  hasChanges?: boolean;

  /**
   * DX-ORD-9 (2026-11-01): where focus goes when the sheet closes. A sheet
   * opened from code (no Radix Trigger) otherwise dropped focus on <body>,
   * and a keyboard user had to Tab from the top of the page back to the row.
   * Since DX-IX-3 every sheet returns focus to the element that had it when
   * it opened; this names a better one (the row's value button when the
   * opener was a field inside it) and wins while it is still on the page.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * The close handler a sheet gives Radix and the Telegram back button:
 * with unsaved changes it asks first (one question at a time) and closes
 * only on "discard". Exported for tests.
 */
export function guardedClose(
  hasChanges: boolean,
  close: () => void,
  confirmDiscard: () => Promise<boolean>,
  asking: { current: boolean },
): void {
  if (!hasChanges) {
    close();
    return;
  }
  if (asking.current) return;
  asking.current = true;
  void confirmDiscard()
    .then((discard) => {
      if (discard) close();
    })
    .finally(() => {
      asking.current = false;
    });
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
  hasChanges = false,
  returnFocusRef,
}: SheetProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  // A11Y-16 (2026-10-31): was the fixed id "sheet-desc", so a sheet opened
  // over another one pointed both dialogs' aria-describedby at whichever
  // element the browser found first.
  const descriptionId = useId();
  const labels = useUiLabels();
  const asking = useRef(false);
  const hasChangesRef = useRef(hasChanges);
  hasChangesRef.current = hasChanges;
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const requestOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        onOpenChangeRef.current(true);
        return;
      }
      guardedClose(
        hasChangesRef.current,
        () => onOpenChangeRef.current(false),
        () => labels.confirmDiscard(labels.discardChanges),
        asking,
      );
    },
    [labels],
  );

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
  useSheetPresence(open, requestOpenChange);
  // DX-IX-2 / DX-IX-3: sheets that must not raise the keyboard (or raise
  // it later) take focus themselves; every sheet gives focus back to the
  // element that opened it when it closes.
  const focus = useSheetFocus(open, contentRef, {
    keepKeyboardDown: disableAutoFocus || !!deferAutoFocusMs,
    returnFocusRef,
  });

  return (
    <Dialog.Root open={open} onOpenChange={requestOpenChange}>
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
          // U11: the toast layer reads where an open sheet sits so a toast
          // never lands on its title (Toast.tsx).
          data-sheet-content=""
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 mx-auto flex w-full max-w-[var(--app-sheet-max-w)] flex-col',
            'rounded-t-[var(--r-sheet)] bg-[var(--c-surface)] text-[var(--c-fg)]',
            'data-[state=open]:animate-[slideUp_var(--t-base)_var(--easing)]',
            'data-[state=closed]:animate-[slideDown_var(--t-quick)_var(--easing)]',
            // V18: .shadow-sheet is the lift AND the hairline in one
            // box-shadow. As two classes (shadow-[…] ring-hairline) the
            // later one replaced the whole property and the lift was lost.
            'pb-[var(--app-safe-bottom)] outline-none shadow-sheet',
          )}
          style={{
            maxHeight:
              'min(calc(90dvh - var(--app-safe-top)), calc(var(--app-viewport-h) - var(--app-safe-top) - 8px))',
          }}
          aria-describedby={description ? descriptionId : undefined}
          tabIndex={-1}
          onOpenAutoFocus={focus.onOpenAutoFocus}
          onCloseAutoFocus={focus.onCloseAutoFocus}
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
              <Dialog.Title className="mt-3 text-center text-old-h2 font-semibold">
                {title}
              </Dialog.Title>
            ) : null}
            {description ? (
              <Dialog.Description id={descriptionId} className="mt-1 text-center text-old-body-sm text-[var(--c-fg-muted)]">
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
      data-sheet-footer=""
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
