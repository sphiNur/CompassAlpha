/**
 * Tests for the tap-guard movement-vs-tap classifier.
 *
 * The hook itself wires document-level pointer + click handlers, which
 * is hard to drive without a full DOM. The decision logic ("did the
 * pointer move enough that this should be classified as a scroll, not
 * a tap") is exported as `updateMoved` + `shouldCancel` for exactly
 * this reason — pin the threshold behavior here so a future tweak
 * can't silently change what counts as a tap.
 *
 * Threshold rationale: 10px is the iOS-native cutoff (UIKit's
 * gesture recognizer uses ~10pt). Anything below that range is the
 * normal jitter of a finger landing on glass; anything above is the
 * user clearly trying to scroll.
 */
import { describe, it, expect } from 'bun:test';
import { shouldCancel, updateMoved } from '../useTapGuard';

function makeState(): {
  pointerId: number | null;
  startX: number;
  startY: number;
  moved: boolean;
  bypass: boolean;
} {
  return { pointerId: 1, startX: 100, startY: 200, moved: false, bypass: false };
}

describe('updateMoved', () => {
  it('does not flip moved for sub-threshold jitter', () => {
    const s = makeState();
    // 5px right, 5px down — well within finger-on-glass jitter.
    updateMoved(s, 105, 205);
    expect(s.moved).toBe(false);
  });

  it('flips moved when horizontal delta crosses threshold', () => {
    const s = makeState();
    updateMoved(s, 111, 200); // dx = 11 > 10
    expect(s.moved).toBe(true);
  });

  it('flips moved when vertical delta crosses threshold (the scroll case)', () => {
    const s = makeState();
    updateMoved(s, 100, 215); // dy = 15 > 10 — typical down-scroll
    expect(s.moved).toBe(true);
  });

  it('treats negative deltas the same (drag up or left also counts)', () => {
    const s = makeState();
    updateMoved(s, 80, 180); // dx=20, dy=20 in the negative direction
    expect(s.moved).toBe(true);
  });

  it('stays moved=true once tripped, even if finger returns to start', () => {
    const s = makeState();
    updateMoved(s, 100, 220); // moved → true
    expect(s.moved).toBe(true);
    updateMoved(s, 100, 200); // back to start
    expect(s.moved).toBe(true); // sticky — the gesture is no longer a clean tap
  });

  it('is a no-op when no pointer is being tracked (pointerId null)', () => {
    const s = { pointerId: null, startX: 0, startY: 0, moved: false, bypass: false };
    updateMoved(s, 100, 100);
    expect(s.moved).toBe(false);
  });
});

describe('shouldCancel', () => {
  it('cancels when moved && !bypass', () => {
    expect(shouldCancel({ moved: true, bypass: false })).toBe(true);
  });

  it('does not cancel a clean tap', () => {
    expect(shouldCancel({ moved: false, bypass: false })).toBe(false);
  });

  it('does not cancel when bypass is set, even if moved', () => {
    // bypass is for elements with [data-allow-drag] in their ancestor
    // chain. We don't have any today but reserving the convention.
    expect(shouldCancel({ moved: true, bypass: true })).toBe(false);
  });

  it('does not cancel when both flags are false', () => {
    expect(shouldCancel({ moved: false, bypass: true })).toBe(false);
  });
});
