import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * DX-IX-2 / DX-IX-3 (2026-11-01): where focus goes when a sheet opens and
 * closes. Our sheets are controlled (`open` state, no Radix
 * `Dialog.Trigger`), so Radix had nothing to return focus to and it fell
 * to <body> after every close; sheets that suppressed the autofocus left
 * focus on the (aria-hidden) button behind them.
 *
 * Opening: a sheet that must not raise the keyboard focuses itself (the
 * content is `tabIndex={-1}`), so keyboard and screen-reader users are
 * inside the dialog without a text field being picked for them.
 *
 * Closing: back to the element that had focus when the sheet opened. If
 * that element is gone (the action removed it), to the page's fallback
 * target, `[data-focus-fallback]` (the shell's <main>).
 */

/** The part of an element this logic touches; a plain object in tests. */
export interface FocusableLike {
  readonly isConnected: boolean;
  focus(options?: FocusOptions): void;
  closest?(selector: string): unknown;
  hasAttribute?(name: string): boolean;
}

export const FOCUS_FALLBACK_SELECTOR = '[data-focus-fallback]';
const OPEN_SHEET_SELECTOR = '[data-sheet-content][data-state="open"]';

/**
 * Picks the element to focus after a sheet closed, or null to leave focus
 * alone. `active` is document.activeElement at that moment: when it is
 * already inside another open sheet (this one opened that one, or one
 * sheet replaced another), moving it would pull focus out of the dialog
 * the person is now in.
 */
export function pickReturnFocus(
  opener: FocusableLike | null,
  active: FocusableLike | null,
  body: unknown,
  fallback: FocusableLike | null,
): FocusableLike | null {
  if (active && active !== body && active.closest?.(OPEN_SHEET_SELECTOR)) return null;
  if (
    opener &&
    opener !== body &&
    opener.isConnected &&
    !opener.hasAttribute?.('disabled') &&
    !opener.closest?.('[aria-hidden="true"],[inert]')
  ) {
    return opener;
  }
  return fallback && fallback.isConnected ? fallback : null;
}

function activeElement(): HTMLElement | null {
  return typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null);
}

/**
 * Wires a Radix Dialog.Content for the behaviour above. `keepKeyboardDown`
 * replaces Radix's "focus the first field" with focusing the sheet itself.
 */
export function useSheetFocus(
  open: boolean,
  contentRef: RefObject<HTMLElement | null>,
  keepKeyboardDown: boolean,
): {
  onOpenAutoFocus: ((e: Event) => void) | undefined;
  onCloseAutoFocus: (e: Event) => void;
} {
  const opener = useRef<HTMLElement | null>(null);
  // A layout effect runs before Radix's FocusScope moves focus into the
  // sheet (that happens in a passive effect), so this still sees the
  // button that opened it.
  useLayoutEffect(() => {
    if (open) opener.current = activeElement();
  }, [open]);

  const onOpenAutoFocus = useCallback(
    (e: Event) => {
      e.preventDefault();
      contentRef.current?.focus({ preventScroll: true });
    },
    [contentRef],
  );

  const onCloseAutoFocus = useCallback((e: Event) => {
    e.preventDefault();
    if (typeof document === 'undefined') return;
    const target = pickReturnFocus(
      opener.current,
      activeElement(),
      document.body,
      document.querySelector<HTMLElement>(FOCUS_FALLBACK_SELECTOR),
    );
    opener.current = null;
    target?.focus({ preventScroll: true });
  }, []);

  return { onOpenAutoFocus: keepKeyboardDown ? onOpenAutoFocus : undefined, onCloseAutoFocus };
}

/**
 * DX-IX-4: after an action removed the button that started it (approve,
 * save a price, "order again"), move focus to `target` when it exists,
 * else to the page fallback, instead of leaving it on <body>. It watches
 * for up to `waitMs` (the list re-renders when the server answers) and
 * acts only if focus actually fell to <body>; if the person moved focus
 * somewhere themselves, or a sheet took it, it leaves it alone.
 */
export function focusAfter(
  target: (() => HTMLElement | null) | string | null,
  waitMs = 0,
): void {
  if (typeof document === 'undefined') return;
  const started = Date.now();
  const lost = () => {
    const active = document.activeElement;
    return !active || active === document.body || !active.isConnected;
  };
  const run = () => {
    if (!lost()) {
      if (Date.now() - started < waitMs) setTimeout(run, 100);
      return;
    }
    const el =
      typeof target === 'string'
        ? document.querySelector<HTMLElement>(target)
        : (target?.() ?? null);
    const next = el ?? document.querySelector<HTMLElement>(FOCUS_FALLBACK_SELECTOR);
    if (!next) return;
    if (!next.hasAttribute('tabindex') && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(next.tagName)) {
      next.setAttribute('tabindex', '-1');
    }
    next.focus({ preventScroll: true });
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(run, 0));
  else setTimeout(run, 0);
}
