import * as Dialog from '@radix-ui/react-dialog';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react';
import { cn } from '../cn';
import { pushTelegramBackHandler } from '../telegramBackStack';
import { useConfirm } from '../confirm';
import { useUiLabels } from '../labels';
import { useSheetFocus } from '../sheetFocus';

/**
 * Shared "how many sheets are currently open?" counter (M1.5,
 * 2026-05-06). Module-level singleton — JS modules are deduplicated
 * across all consumers, so this is the org-wide source of truth.
 *
 * Why: Telegram's WebApp BackButton APPENDS click handlers (not
 * replace). When a section frame and an open sheet both registered
 * handlers, a single back-tap fired both — drilling the section up
 * AND closing the sheet at once — so the section frame turned its own
 * BackButton off while any sheet was open. Since CA-34 the button is
 * owned through ../telegramBackStack (see below). The count is read by
 * the toast stack, which follows an open sheet (Toast.tsx), and by the
 * web app's update check, which does not reload under an open sheet.
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
 * The counter as React state. The toast stack reads it to follow an
 * open sheet (Toast.tsx).
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
 * the open-sheet count, and a Telegram BackButton that closes it.
 */
function useSheetPresence(open: boolean, onOpenChange: (open: boolean) => void): void {
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

export interface SheetProps {
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
   * DX-DLV-08 (2026-11-01): on open, move focus to the sheet's title. No
   * input is focused, so the iOS keyboard does not pop, and screen-reader
   * users hear which form opened (focusing the sheet box, as
   * `disableAutoFocus` does, names nothing). Wins over `deferAutoFocusMs`.
   */
  focusTitleOnOpen?: boolean;

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

/**
 * Review UI-26 (2026-11-12): the top chrome a sheet or a toast keeps clear
 * of. In Telegram that is its Close / ⋯ row over the page with the safe
 * area above it (--app-chrome-reserve, which the host measures and sets;
 * TopBar reserves the same strip); elsewhere the safe area alone.
 */
export const TOP_CHROME = 'var(--app-chrome-reserve, var(--app-safe-top))';

/**
 * A sheet is at most 90% of the screen, and its top stays 8 px below the
 * top chrome when the keyboard leaves a short viewport. That second term
 * subtracted only --app-safe-top (16 px on Android, where env() is 0), so
 * a tall sheet's handle and title could slide under Telegram's buttons
 * (UI-26). Exported for tests.
 */
export const SHEET_MAX_HEIGHT = `min(calc(90dvh - var(--app-safe-top)), calc(var(--app-viewport-h) - ${TOP_CHROME} - 8px))`;

/** A flick: let go while moving down at least this fast (px per ms)… */
const SHEET_FLICK_SPEED = 0.5;
/** …after a pull of at least this much (px), so a tap's jitter is none. */
const SHEET_FLICK_MIN_PX = 24;

/**
 * Review UI-25 (2026-11-12): whether letting go of a sheet pulled down by
 * its header closes it: pulled past a quarter of its height, or flicked
 * down. Otherwise it springs back. `pulled` and `height` in px (down is
 * positive), `speed` in px per ms when the finger lifted. Exported for
 * tests.
 */
export function sheetDragCloses(pulled: number, speed: number, height: number): boolean {
  if (pulled <= 0) return false;
  if (speed >= SHEET_FLICK_SPEED && pulled >= SHEET_FLICK_MIN_PX) return true;
  return pulled >= height / 4;
}

/** Back to where an open sheet rests, with no transform left on it. */
function springSheetBack(panel: HTMLElement | null): void {
  if (!panel?.style.transform) return;
  panel.style.transition = 'transform var(--t-quick) var(--easing)';
  panel.style.transform = '';
  panel.style.removeProperty('--sheet-drag');
}

interface SheetDrag {
  pointerId: number;
  startY: number;
  lastY: number;
  lastTime: number;
  speed: number;
}

/**
 * Review UI-25: the pull behind the drag handle, which drew a handle but
 * had no drag. A finger (touch or pen; a mouse has Esc and the backdrop)
 * on the header pulls the panel down; see sheetDragCloses. The panel
 * follows through its inline transform, set directly so a drag renders
 * nothing, and only while pulled: a transform left on the panel would
 * make it the containing block of anything fixed inside it. A close
 * slides out from where the finger let go (--sheet-drag, read by
 * slideDown in tokens.css).
 */
function useSheetDrag(
  open: boolean,
  contentRef: RefObject<HTMLDivElement | null>,
  close: () => void,
): HTMLAttributes<HTMLDivElement> {
  const drag = useRef<SheetDrag | null>(null);
  const pull = (px: number) => {
    const panel = contentRef.current;
    if (!panel) return;
    panel.style.transition = 'none';
    panel.style.transform = `translateY(${px}px)`;
    panel.style.setProperty('--sheet-drag', `${px}px`);
  };
  const springBack = () => springSheetBack(contentRef.current);
  // Reopened while still sliding out: start from the top again.
  useEffect(() => {
    if (open) springSheetBack(contentRef.current);
  }, [open, contentRef]);
  return {
    onPointerDown: (e) => {
      if (e.pointerType === 'mouse' || drag.current) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = {
        pointerId: e.pointerId,
        startY: e.clientY,
        lastY: e.clientY,
        lastTime: e.timeStamp,
        speed: 0,
      };
    },
    onPointerMove: (e) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      d.speed = (e.clientY - d.lastY) / Math.max(1, e.timeStamp - d.lastTime);
      d.lastY = e.clientY;
      d.lastTime = e.timeStamp;
      pull(Math.max(0, e.clientY - d.startY));
    },
    onPointerUp: (e) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      drag.current = null;
      const panel = contentRef.current;
      // A finger that stopped before it lifted did not flick.
      const speed = e.timeStamp - d.lastTime > 100 ? 0 : d.speed;
      const pulled = Math.max(0, e.clientY - d.startY);
      if (!panel || !sheetDragCloses(pulled, speed, panel.offsetHeight)) {
        springBack();
        return;
      }
      close();
      // Still open on the next frame (unsaved changes ask first; a
      // pending confirm cannot close): spring back.
      requestAnimationFrame(() => {
        if (panel.getAttribute('data-state') === 'open') springBack();
      });
    },
    onPointerCancel: (e) => {
      if (drag.current?.pointerId !== e.pointerId) return;
      drag.current = null;
      springBack();
    },
  };
}

/**
 * True from the first time `open` is true onwards. DX-PFE-5 (2026-11-01):
 * every closed sheet still rendered Radix's Dialog root, provider, portal
 * and presence — six components per sheet on every parent render, and
 * most rows carry one (142 Dialog instances on the purchase screen's
 * first draw). A sheet now mounts the first time it opens and then stays
 * mounted, so closing still animates out, focus still returns to the
 * opener, and a reopened sheet behaves exactly as before.
 */
export function useOpenedOnce(open: boolean): boolean {
  const [opened, setOpened] = useState(open);
  // Adjusting state during render (React's documented pattern): the sheet
  // mounts in the same render that opens it, not one frame later.
  if (open && !opened) setOpened(true);
  return open || opened;
}

/** A tap that landed on the toast layer (Toast.tsx), not outside a sheet. */
function isToastTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-toast-stack]') !== null;
}

export function Sheet(props: SheetProps) {
  const mounted = useOpenedOnce(props.open);
  return mounted ? <OpenedSheet {...props} /> : null;
}

function OpenedSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  disableAutoFocus = false,
  deferAutoFocusMs,
  hasChanges = false,
  focusTitleOnOpen = false,
  returnFocusRef,
}: SheetProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  // A11Y-16 (2026-10-31): was the fixed id "sheet-desc", so a sheet opened
  // over another one pointed both dialogs' aria-describedby at whichever
  // element the browser found first.
  const descriptionId = useId();
  const labels = useUiLabels();
  const confirm = useConfirm();
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
        // UX-07: the in-app ConfirmSheet (the host's ConfirmProvider), no
        // longer Telegram's native popup.
        () => confirm({ title: labels.discardChanges, confirmLabel: labels.discard, danger: true }),
        asking,
      );
    },
    [confirm, labels],
  );

  // Deferred-focus implementation: when `deferAutoFocusMs` is set, we
  // preventDefault on Radix's onOpenAutoFocus (so it doesn't fire
  // immediately during slideUp), then setTimeout to find the first
  // focusable inside the dialog and focus it ourselves. After
  // slideUp completes (240ms), the sheet is in final position; the
  // keyboard pops without scroll-jumping the WebView.
  useEffect(() => {
    if (!open || disableAutoFocus || !deferAutoFocusMs || focusTitleOnOpen) return;
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
  }, [open, disableAutoFocus, deferAutoFocusMs, focusTitleOnOpen]);
  useSheetPresence(open, requestOpenChange);
  // DX-IX-2 / DX-IX-3: sheets that must not raise the keyboard (or raise
  // it later) take focus themselves; every sheet gives focus back to the
  // element that opened it when it closes.
  // DX-DLV-08: `focusTitleOnOpen` keeps the keyboard down too, but lands
  // on the title rather than the sheet box, so the form is announced by
  // its name.
  const focus = useSheetFocus(open, contentRef, {
    keepKeyboardDown: disableAutoFocus || !!deferAutoFocusMs || focusTitleOnOpen,
    keyboardDownTargetRef: focusTitleOnOpen ? titleRef : undefined,
    returnFocusRef,
  });
  const drag = useSheetDrag(open, contentRef, () => requestOpenChange(false));

  return (
    <Dialog.Root open={open} onOpenChange={requestOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-[var(--c-scrim)]',
            // Review MWB-12: an opacity change, timed by --t-fade, which
            // reduced motion keeps (tokens.css); the panel fades there too.
            'data-[state=open]:animate-[fadeIn_var(--t-fade)_var(--easing)]',
            'data-[state=closed]:animate-[fadeOut_var(--t-fade)_var(--easing)]',
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
          style={{ maxHeight: SHEET_MAX_HEIGHT }}
          aria-describedby={description ? descriptionId : undefined}
          tabIndex={-1}
          onOpenAutoFocus={focus.onOpenAutoFocus}
          onCloseAutoFocus={focus.onCloseAutoFocus}
          // Review MWB-02 (modern-web-guidance: light-dismiss-a-dialog): a
          // tap on a toast (its Undo, its close) is not a tap outside the
          // sheet. Toasts sit above every layer; Radix counted the tap as
          // outside and closed the sheet, or asked to discard its changes.
          onInteractOutside={(event) => {
            if (isToastTarget(event.target)) event.preventDefault();
          }}
        >
          {/* The header (handle and title) pulls the sheet down (UI-25);
              touch-none keeps the pull from panning the page. */}
          <SheetHeader className="touch-none" {...drag}>
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
              <Dialog.Title
                ref={titleRef}
                tabIndex={focusTitleOnOpen ? -1 : undefined}
                className="mt-3 text-center text-old-h2 font-semibold outline-none"
              >
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

export function SheetHeader({ children, className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('px-[var(--app-inline-x)] pt-3 pb-2', className)} {...rest}>
      {children}
    </div>
  );
}

export function SheetBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'min-h-0 flex-1 overflow-y-auto overscroll-contain px-[var(--app-inline-x)] pb-4',
        className,
      )}
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
        // One side inset, --app-inline-x; a px-4 before it was overridden (UI-34).
        'sticky bottom-0 mt-auto bg-[var(--c-surface)] px-[var(--app-inline-x)] pb-3 pt-2',
        'border-t border-[var(--c-divider)]',
        className,
      )}
    >
      {children}
    </div>
  );
}
