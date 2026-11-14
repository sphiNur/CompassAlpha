import { useEffect, useLayoutEffect, useRef } from 'react';
import { useTapGuard } from '@compass/ui';
import { useAppMutating } from '../../hooks/useAppMutating';
import { useI18n } from '../../hooks/useI18n';
import { announce } from '../../lib/announce';
import { usePageMainButtonState } from '../../hooks/usePageMainButton';
import { publishMainButtonInset } from '../../lib/mainButtonInset';

/**
 * In-DOM page primary action button (M3.49, 2026-05-23). Reads from the
 * module-level store written by usePageMainButton(). Renders nothing
 * when no page has registered an action — the nav rises against the
 * page content. When a page sets one, a sticky bar appears ABOVE the
 * nav with the action's text + click handler.
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
  // started it. aria-busy alone is barely read. No spinner (the look
  // stays).
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
  // own in-DOM equivalent above the bottom nav. The hide() call is
  // idempotent on the SDK side.
  useEffect(() => {
    const tg = typeof window !== 'undefined' ? window.Telegram?.WebApp : null;
    if (!tg) return;
    tg.MainButton.hide();
  }, [state?.visible]);

  // 2026-10-21 FE-05: publish this bar's height as --app-main-btn-h so the
  // toast stack (anchored above the nav) clears it instead of covering it.
  const barRef = useRef<HTMLDivElement>(null);
  const shown = Boolean(state?.visible);
  // 2026-11-14: `data-main-button` on <html> tells the shell's CSS
  // (styles/index.css) that the page ends above this bar, so <main> keeps
  // no room of its own for the floating nav and shows no bottom fade.
  useLayoutEffect(() => {
    const el = barRef.current;
    const html = typeof document !== 'undefined' ? document.documentElement : null;
    if (!shown || !el) {
      publishMainButtonInset(0);
      html?.removeAttribute('data-main-button');
      return;
    }
    html?.setAttribute('data-main-button', '');
    publishMainButtonInset(el.offsetHeight);
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => publishMainButtonInset(el.offsetHeight))
        : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      publishMainButtonInset(0);
      html?.removeAttribute('data-main-button');
    };
  }, [shown]);

  if (!state || !state.visible) return null;
  const interactable = state.active && !busy;
  // A11Y-2: an inactive button whose page can say why stays in the Tab
  // order (aria-disabled) and points at the problem when used.
  const explains = !interactable && !busy && !!state.onInactiveClick;
  const hint = !interactable && !busy ? state.inactiveHint : undefined;
  // 2026-11-14: the nav capsule floats over the foot of this bar (its
  // room is --app-nav-reserve under the button), so the button sits
  // above the capsule, never under it. The published height is the
  // button's own part, above that room.
  return (
    <div
      className="shrink-0 border-t border-[var(--c-divider)] bg-[var(--c-surface)]"
      style={{ paddingBottom: 'var(--app-nav-reserve)' }}
    >
      <div
        ref={barRef}
        style={{
          // The page's own side inset, or more on a phone on its side,
          // where the notch and rounded corners are (COREWEB1-07). Review
          // COREWEB1-31 (2026-11-12): the inset is the token, not 16px.
          paddingLeft: 'max(var(--app-inline-x), var(--app-safe-left, 0px))',
          paddingRight: 'max(var(--app-inline-x), var(--app-safe-right, 0px))',
          paddingTop: 8,
          paddingBottom: 8,
        }}
      >
        {hint ? (
          <p
            id="page-main-button-hint"
            data-testid="page-main-button-hint"
            className="mb-2 text-center text-old-label text-[var(--c-fg-muted)]"
          >
            {hint}
          </p>
        ) : null}
        <button
          ref={buttonRef}
          type="button"
          data-testid="page-main-button"
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
          // Review MWA-10 (modern-web-guidance: respect-os-text-scale): 48px
          // is a minimum, so the bar grows with larger phone text (its
          // height is measured and published above) instead of clipping.
          className={
            'flex min-h-12 w-full min-w-0 items-center justify-center rounded-[var(--r-pill)] px-4 text-old-h3 font-semibold ' +
            (interactable
              ? 'bg-[var(--c-action)] text-[var(--c-action-fg)] active:opacity-80'
              : 'bg-[var(--c-surface-2)] text-[var(--c-fg-muted)]')
          }
        >
          <span className="min-w-0 truncate">{state.text}</span>
        </button>
      </div>
    </div>
  );
}

/**
 * Review MWB-10: whether the write that just started is said: the main
 * button has focus, or was pressed in the last second (a tap on a phone
 * does not always focus it). A write from elsewhere says nothing here.
 */
export function mainButtonSaysBusy(focused: boolean, pressedAt: number, now: number): boolean {
  return focused || (pressedAt > 0 && now - pressedAt <= 1000);
}
