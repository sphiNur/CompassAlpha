import { useEffect, useLayoutEffect, useRef } from 'react';
import { IconCheck, IconRun, IconSend, IconTruck, Spinner, useTapGuard } from '@compass/ui';
import { useAppMutating } from '../../hooks/useAppMutating';
import { useI18n } from '../../hooks/useI18n';
import { announce } from '../../lib/announce';
import { usePageMainButtonState, type PageMainButtonIcon } from '../../hooks/usePageMainButton';
import { mainButtonInsetOf, publishMainButtonInset } from '../../lib/mainButtonInset';
import { NAV_BADGE_COUNT_CLASS, navBadgeCountText } from './navBadgeLook';

/**
 * In-DOM page primary action button (M3.49, 2026-05-23). Reads from the
 * module-level store written by usePageMainButton(). Renders nothing
 * when no page has registered an action. When a page sets one, the
 * button floats in the shell's dock (Shell.tsx) with the nav capsule:
 * since 2026-11-14 (owner) on the capsule's row, a circle with the
 * action's icon in a capsule of its own (`.app-dock` in
 * styles/index.css).
 *
 * Telegram's native MainButton is kept permanently hidden (effect
 * below) so the two don't compete for the bottom-of-screen slot.
 *
 * Review COREWEB1-10 (2026-11-12): out of Shell.tsx.
 */
export function PageMainButton() {
  const state = usePageMainButtonState();
  // M3.50: also guard against re-tap during any in-flight mutation
  // (not just the one this button started). Without this guard, the
  // user could tap Save, then while it's processing tap a
  // sibling-screen's main button (e.g. switch tab → submit there)
  // and create a race.
  const busy = useAppMutating();
  // DLV-4 / BUY-12: a double tap fired twice before `busy` disabled it.
  const guardTap = useTapGuard();
  const i18n = useI18n();
  // Review MWB-10 (modern-web-guidance: progress): while a write is in
  // flight the button stays focusable (aria-disabled, the click dropped)
  // instead of `disabled`, which threw focus off it, and "Please wait…"
  // is said through the app's polite region when this button's press
  // started it. aria-busy alone is barely read.
  const buttonRef = useRef<HTMLButtonElement>(null);
  const pressedAt = useRef(0);
  const wasBusy = useRef(busy);
  useEffect(() => {
    const started = busy && !wasBusy.current;
    wasBusy.current = busy;
    if (!started) return;
    const focused = !!buttonRef.current && document.activeElement === buttonRef.current;
    if (mainButtonSaysBusy(focused, pressedAt.current, Date.now())) {
      announce(i18n.t('common.busy'));
    }
  }, [busy, i18n]);
  // Permanently hide Telegram's native MainButton — we render our
  // own in-DOM equivalent beside the bottom nav. The hide() call is
  // idempotent on the SDK side.
  useEffect(() => {
    const tg = typeof window !== 'undefined' ? window.Telegram?.WebApp : null;
    if (!tg) return;
    tg.MainButton.hide();
  }, [state?.visible]);

  // 2026-10-21 FE-05: publish what the button adds above the nav as
  // --app-main-btn-h, so the toast stack (anchored above the nav) and the
  // room <main> keeps under its last content clear it. 2026-11-14: on the
  // nav's row that is nothing, or the hint over the row; without the nav,
  // the dock from the button's (or the hint's) top (mainButtonInsetOf).
  const colRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLParagraphElement>(null);
  const shown = Boolean(state?.visible);
  const interactable = !!state && state.active && !busy;
  const hint = state && !interactable && !busy ? state.inactiveHint : undefined;
  const hasHint = !!hint;
  // 2026-11-14: `data-main-button` on <html> tells the shell's CSS
  // (styles/index.css) to show the capsule beside the button with icons
  // only.
  useLayoutEffect(() => {
    const col = colRef.current;
    const html = typeof document !== 'undefined' ? document.documentElement : null;
    if (!shown || !col) {
      publishMainButtonInset(0);
      html?.removeAttribute('data-main-button');
      return;
    }
    html?.setAttribute('data-main-button', '');
    const dock = col.closest<HTMLElement>('.app-dock');
    const measure = () => {
      const nav = dock?.querySelector<HTMLElement>('.app-nav') ?? null;
      const hintEl = hintRef.current;
      const top = Math.min(
        col.getBoundingClientRect().top,
        hintEl ? hintEl.getBoundingClientRect().top : Infinity,
      );
      publishMainButtonInset(
        mainButtonInsetOf({
          navTop: nav ? nav.getBoundingClientRect().top : null,
          contentTop: top,
          dockBottom: (dock ?? col).getBoundingClientRect().bottom,
        }),
      );
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(col);
    if (dock) ro?.observe(dock);
    if (hintRef.current) ro?.observe(hintRef.current);
    return () => {
      ro?.disconnect();
      publishMainButtonInset(0);
      html?.removeAttribute('data-main-button');
    };
  }, [shown, hasHint]);

  if (!state || !state.visible) return null;
  // A11Y-2: an inactive button whose page can say why stays in the Tab
  // order (aria-disabled) and points at the problem when used.
  const explains = !interactable && !busy && !!state.onInactiveClick;
  const Icon = MAIN_BUTTON_ICONS[state.icon] ?? IconCheck;
  // 2026-11-14 (owner): the button floats in the dock with the nav
  // capsule (Shell.tsx), after it in the Tab order, on the capsule's row:
  // a circle the size of the open tab's pill, in a capsule of the nav's
  // glass. No words on it; they are its accessible name and its title. A
  // count rides it as a corner badge, as on the tabs. Swipes between tabs
  // never start here: the dock is outside the pager (SwipePager.tsx).
  return (
    <div ref={colRef} className="app-dock-action">
      {hint ? (
        <p
          ref={hintRef}
          id="page-main-button-hint"
          data-testid="page-main-button-hint"
          className="app-dock-hint text-center text-old-label text-[var(--c-fg-muted)]"
        >
          {hint}
        </p>
      ) : null}
      <div className="app-main-capsule">
        <button
          ref={buttonRef}
          type="button"
          data-testid="page-main-button"
          aria-label={state.text}
          title={state.text}
          disabled={(!interactable && !explains && !busy) || undefined}
          aria-disabled={explains || busy || undefined}
          aria-describedby={hint ? 'page-main-button-hint' : undefined}
          onClick={
            busy
              ? undefined
              : explains
                ? state.onInactiveClick
                : () => {
                    pressedAt.current = Date.now();
                    guardTap(state.onClick, state.text)?.();
                  }
          }
          aria-busy={busy || undefined}
          className={
            'app-main-btn press relative flex items-center justify-center rounded-full ' +
            (interactable
              ? 'bg-[var(--c-action)] text-[var(--c-action-fg)] active:opacity-80'
              : 'bg-[var(--c-surface-2)] text-[var(--c-fg-muted)]')
          }
        >
          {/* Review MWB-10 (V5, modern-web-guidance: progress): a busy main
                button shows the kit spinner, here in the icon's place. */}
          {busy ? <Spinner size={22} /> : <Icon size={24} />}
          {state.badge ? (
            <span
              aria-hidden
              data-testid="page-main-button-badge"
              className={`absolute -right-1 -top-1 ${NAV_BADGE_COUNT_CLASS}`}
            >
              {navBadgeCountText(state.badge)}
            </span>
          ) : null}
        </button>
      </div>
    </div>
  );
}

/** The circle's icon per action (usePageMainButton's `icon`). */
const MAIN_BUTTON_ICONS: Record<PageMainButtonIcon, typeof IconCheck> = {
  check: IconCheck,
  send: IconSend,
  cart: IconRun,
  truck: IconTruck,
};

/**
 * Review MWB-10: whether the write that just started is said: the main
 * button has focus, or was pressed in the last second (a tap on a phone
 * does not always focus it). A write from elsewhere says nothing here.
 */
export function mainButtonSaysBusy(focused: boolean, pressedAt: number, now: number): boolean {
  return focused || (pressedAt > 0 && now - pressedAt <= 1000);
}
