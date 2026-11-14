import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { createOwnerStack, type OwnerHandle } from '../lib/ownerStack';

/**
 * Page-primary-action state — M3.49 (2026-05-23).
 *
 * Was: drove Telegram's native MainButton via tg.MainButton.show()/
 * setText()/onClick(). That button lives BELOW the WebView, which
 * meant our bottom nav shifted up whenever a primary action was
 * present. The user wanted the bottom nav to stay anchored to the
 * screen bottom at ALL times — non-negotiable.
 *
 * Now: usePageMainButton writes to a module-level store, and the Shell
 * renders <PageMainButton /> (app/shell/PageMainButton.tsx) in-DOM, in
 * the dock with the nav (since 2026-11-14 a circle on the nav's row, its
 * text the accessible name). Telegram's native MainButton stays
 * permanently hidden (PageMainButton calls tg.MainButton.hide()). The
 * nav is now the last flex child in the Shell, so it owns the bottom
 * edge regardless of whether a primary action is showing.
 *
 * Trade-offs accepted:
 *   - Loses Telegram's native MainButton look. We render a styled
 *     button with the same action accent color, sized comparably.
 *   - Need to call haptic() manually on tap (existing call sites
 *     already do so on success — no behavior loss).
 *   - Button + nav now share thumb-reach space. Mitigated by the
 *     ~8px gap + bg-color contrast.
 *
 * Review COREWEB2-14 (2026-11-11): moved out of hooks/useTelegram.ts. The
 * button has had nothing to do with Telegram since M3.49.
 */
/**
 * The icon of the main button's circle (owner, 2026-11-14): what the
 * action does, drawn from the kit's nav icon set (PageMainButton.tsx).
 */
export type PageMainButtonIcon = 'check' | 'send' | 'cart' | 'truck';

interface PageMainButtonState {
  /** The action's words: the button's accessible name and title. */
  text: string;
  /** Default 'check'. */
  icon: PageMainButtonIcon;
  /**
   * A count the action carries ("Submit order (3)"), shown on the circle
   * as a corner badge like the nav's. The text still says it in full.
   */
  badge?: number;
  onClick: () => void;
  visible: boolean;
  active: boolean;
  /**
   * A11Y-2 (2026-10-31): set when the page can say why the button is
   * inactive (fields to correct). The button then stays focusable with
   * aria-disabled instead of `disabled`, and a tap runs this (the
   * settlement page jumps to the first field to fix).
   */
  onInactiveClick?: () => void;
  /**
   * 2026-11-13: one line over the inactive button saying why it is
   * inactive ("Expense 1 · Amount: enter the amount."). A greyed save with
   * no reason left a cashier stuck on a template expense without a price.
   */
  inactiveHint?: string;
}

let _pageMainButton: PageMainButtonState | null = null;
const _pageMainButtonListeners = new Set<() => void>();

// 2026-10-21 audit CA-34 / E-23: was a single slot (last write wins, first
// unmount clears it for everyone). Owners now stack; the top one renders.
const _pageMainButtonStack = createOwnerStack<PageMainButtonState>((top) => {
  _pageMainButton = top;
  _pageMainButtonListeners.forEach((l) => l());
});

function subscribePageMainButton(listener: () => void): () => void {
  _pageMainButtonListeners.add(listener);
  return () => {
    _pageMainButtonListeners.delete(listener);
  };
}

const pageMainButtonSnapshot = (): PageMainButtonState | null => _pageMainButton;

/**
 * Subscribe React to the page-main-button state. Used by the
 * <PageMainButton /> component (app/shell/PageMainButton.tsx).
 *
 * Review COREWEB2-28: through useSyncExternalStore, which also catches a
 * change made between the render and the subscription. A page's effect
 * can push its button in that gap; an effect-made subscription missed it,
 * and the button waited for Shell to draw again for another reason.
 */
export function usePageMainButtonState(): PageMainButtonState | null {
  return useSyncExternalStore(subscribePageMainButton, pageMainButtonSnapshot, () => null);
}

export function usePageMainButton(
  text: string,
  onClick: () => void,
  opts?: {
    visible?: boolean;
    active?: boolean;
    onInactiveClick?: () => void;
    inactiveHint?: string;
    icon?: PageMainButtonIcon;
    badge?: number;
  },
): void {
  // Keep the click callback in a ref so re-renders don't republish
  // state — we only republish when text/visible/active actually flip.
  const onClickRef = useRef(onClick);
  onClickRef.current = onClick;
  const onInactiveRef = useRef(opts?.onInactiveClick);
  onInactiveRef.current = opts?.onInactiveClick;
  const hasInactiveClick = !!opts?.onInactiveClick;
  const inactiveClick = useMemo(
    () => (hasInactiveClick ? () => onInactiveRef.current?.() : undefined),
    [hasInactiveClick],
  );
  const safeText = (text ?? '').trim();
  const wantVisible = opts?.visible !== false && !!safeText;
  const wantActive = opts?.active !== false;
  const inactiveHint = opts?.inactiveHint?.trim() || undefined;
  const icon = opts?.icon ?? 'check';
  const badge =
    typeof opts?.badge === 'number' && Number.isFinite(opts.badge) && opts.badge > 0
      ? Math.floor(opts.badge)
      : undefined;
  const stateRef = useRef<PageMainButtonState>({
    text: safeText,
    icon,
    badge,
    onClick: () => onClickRef.current(),
    visible: wantVisible,
    active: wantActive,
  });
  stateRef.current = {
    ...stateRef.current,
    text: safeText,
    icon,
    badge,
    visible: wantVisible,
    active: wantActive,
    onInactiveClick: inactiveClick,
    inactiveHint,
  };
  const handleRef = useRef<OwnerHandle<PageMainButtonState> | null>(null);
  // Register once per mount so a text/visibility change never reorders
  // this owner above one that mounted later.
  useEffect(() => {
    const handle = _pageMainButtonStack.push(stateRef.current);
    handleRef.current = handle;
    return () => {
      handleRef.current = null;
      handle.release();
    };
  }, []);
  useEffect(() => {
    handleRef.current?.update({
      ...stateRef.current,
      text: safeText,
      icon,
      badge,
      visible: wantVisible,
      active: wantActive,
      onInactiveClick: inactiveClick,
      inactiveHint,
    });
  }, [safeText, icon, badge, wantVisible, wantActive, inactiveClick, inactiveHint]);
}
