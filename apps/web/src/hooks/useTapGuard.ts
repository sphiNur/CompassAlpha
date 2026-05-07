import { useEffect } from 'react';

/**
 * Suppress accidental button activations during scroll gestures.
 *
 * The bug this fixes: on touch screens, browsers map touch sequences to
 * a synthetic `click` event when the touch ends over the same element
 * it started on, EVEN IF the user moved their finger significantly in
 * between. In a scrolling list of dense controls (the OrderPage SKU
 * cards with +/- buttons, the ApprovalPage queue rows, the RunPage
 * dispatch toolbar) a downward swipe started on a button frequently
 * scrolls the list AND fires the button's onClick — causing accidental
 * qty changes, accidental approve/reject, etc. The user explicitly
 * reported this as a real source of order errors.
 *
 * The fix is the FastClick-era pattern: between a pointerdown and the
 * resulting click, track the pointer's max distance from its start. If
 * that distance crosses a threshold (10px is the iOS-native cutoff for
 * "this was a scroll, not a tap") we cancel the click in the capture
 * phase before React's delegated listener sees it.
 *
 * Implementation notes:
 *
 * - Capture phase on document is reliable: document-level capture
 *   handlers fire before React's root-level bubble handlers (React
 *   delegates click to the root since 17), so stopImmediatePropagation
 *   here actually prevents the React onClick from running.
 *
 * - We only guard touch + pen pointers. Mouse moves between mousedown
 *   and mouseup are virtually always intentional (a drag, click-drag-
 *   release pattern); cancelling them would break selection on desktop.
 *
 * - State is per-pointer-id, but we only track ONE active pointer.
 *   Telegram WebView is single-touch dominant; multi-touch buttons
 *   aren't a thing in this app. If a second touch starts before the
 *   first ends we reset (the first is no longer a clean tap).
 *
 * - Reset on pointercancel so a swipe that the OS classifies as a
 *   gesture (e.g. iOS edge-swipe) doesn't leave us in a stuck state.
 *
 * - Opt-out: any element with `data-allow-drag` in its ancestor chain
 *   skips the guard. Add this to drag handles, sliders, etc. We don't
 *   have any today, but the hook reserves the attribute so we don't
 *   need to introduce a new convention later.
 */

/** Pixel distance beyond which a touch is treated as a scroll, not a tap. */
const MOVE_THRESHOLD_PX = 10;

interface GuardState {
  pointerId: number | null;
  startX: number;
  startY: number;
  moved: boolean;
  /** True if the pointerdown target opted out (data-allow-drag). */
  bypass: boolean;
}

function makeState(): GuardState {
  return { pointerId: null, startX: 0, startY: 0, moved: false, bypass: false };
}

/** Internal — exported only so unit tests can drive it deterministically. */
export function shouldCancel(
  state: Pick<GuardState, 'moved' | 'bypass'>,
): boolean {
  return state.moved && !state.bypass;
}

/** Internal — exported only so unit tests can drive it deterministically. */
export function updateMoved(
  state: GuardState,
  clientX: number,
  clientY: number,
): boolean {
  if (state.pointerId === null) return state.moved;
  const dx = Math.abs(clientX - state.startX);
  const dy = Math.abs(clientY - state.startY);
  if (dx > MOVE_THRESHOLD_PX || dy > MOVE_THRESHOLD_PX) {
    state.moved = true;
  }
  return state.moved;
}

function isOptOut(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest('[data-allow-drag]') !== null;
}

export function useTapGuard(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const state: GuardState = makeState();

    const onPointerDown = (e: PointerEvent) => {
      // Mouse drags are intentional; only touch/pen need the guard.
      if (e.pointerType === 'mouse') {
        state.pointerId = null;
        return;
      }
      state.pointerId = e.pointerId;
      state.startX = e.clientX;
      state.startY = e.clientY;
      state.moved = false;
      state.bypass = isOptOut(e.target);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (state.pointerId !== e.pointerId) return;
      updateMoved(state, e.clientX, e.clientY);
    };

    const onPointerEnd = (e: PointerEvent) => {
      // Don't reset `moved` here — we need it to survive until the
      // synthetic click fires on the SAME tick. Reset happens after
      // the click handler runs (or on the next pointerdown).
      if (state.pointerId !== e.pointerId) return;
      // We keep moved/bypass; release the pointerId so a stray
      // pointermove after up doesn't keep mutating moved.
      state.pointerId = null;
    };

    const onPointerCancel = (e: PointerEvent) => {
      if (state.pointerId !== e.pointerId) return;
      // OS reclaimed the gesture (edge swipe, etc). Treat as scroll —
      // there will be no synthetic click, but if there is, kill it.
      state.moved = true;
      state.pointerId = null;
    };

    const onClickCapture = (e: MouseEvent) => {
      if (shouldCancel(state)) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
      // Reset for the next interaction. If pointerdown for the next
      // tap has already fired (rare but possible on very fast double-
      // taps) we DON'T want to clobber its state, so we only clear
      // movement, not the still-valid pointerId.
      if (state.pointerId === null) {
        state.moved = false;
        state.bypass = false;
      }
    };

    // Capture phase on document so we beat React's root-level click
    // delegation. `passive: true` on pointer events because we never
    // call preventDefault on them — that would block scrolling itself.
    document.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
    document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
    document.addEventListener('pointerup', onPointerEnd, { capture: true, passive: true });
    document.addEventListener('pointercancel', onPointerCancel, { capture: true, passive: true });
    document.addEventListener('click', onClickCapture, { capture: true });

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, { capture: true });
      document.removeEventListener('pointermove', onPointerMove, { capture: true });
      document.removeEventListener('pointerup', onPointerEnd, { capture: true });
      document.removeEventListener('pointercancel', onPointerCancel, { capture: true });
      document.removeEventListener('click', onClickCapture, { capture: true });
    };
  }, []);
}
