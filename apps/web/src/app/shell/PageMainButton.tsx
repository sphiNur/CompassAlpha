import { useEffect, useLayoutEffect, useRef } from 'react';
import { useTapGuard } from '@compass/ui';
import { useAppMutating } from '../../hooks/useAppMutating';
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
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!shown || !el) {
      publishMainButtonInset(0);
      return;
    }
    publishMainButtonInset(el.offsetHeight);
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => publishMainButtonInset(el.offsetHeight))
        : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      publishMainButtonInset(0);
    };
  }, [shown]);

  if (!state || !state.visible) return null;
  const interactable = state.active && !busy;
  // A11Y-2: an inactive button whose page can say why stays in the Tab
  // order (aria-disabled) and points at the problem when used.
  const explains = !interactable && !busy && !!state.onInactiveClick;
  const hint = !interactable && !busy ? state.inactiveHint : undefined;
  return (
    <div
      ref={barRef}
      className="shrink-0 border-t border-[var(--c-divider)] bg-[var(--c-surface)]"
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
        type="button"
        data-testid="page-main-button"
        disabled={!interactable && !explains}
        aria-disabled={explains || undefined}
        aria-describedby={hint ? 'page-main-button-hint' : undefined}
        onClick={explains ? state.onInactiveClick : guardTap(state.onClick, state.text)}
        aria-busy={busy || undefined}
        className={
          'flex h-12 w-full min-w-0 items-center justify-center rounded-[var(--r-pill)] px-4 text-old-h3 font-semibold ' +
          (interactable
            ? 'bg-[var(--c-action)] text-[var(--c-action-fg)] active:opacity-80'
            : 'bg-[var(--c-surface-2)] text-[var(--c-fg-muted)]')
        }
      >
        <span className="min-w-0 truncate">{state.text}</span>
      </button>
    </div>
  );
}
