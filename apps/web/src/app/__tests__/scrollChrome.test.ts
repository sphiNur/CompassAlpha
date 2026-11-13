import { describe, expect, test } from 'bun:test';
import { COMPACT_MIN_SCROLL_PX, COMPACT_STEP_PX, nextCompact } from '../shell/scrollChrome';

const full = { compact: false, anchor: 0 };
const long = 2_000;

describe('the nav capsule while the page scrolls (2026-11-14)', () => {
  test('shrinks scrolling down, returns scrolling up', () => {
    const down = nextCompact(full, { top: 40, scrollable: long }, false);
    expect(down).toEqual({ compact: true, anchor: 40 });
    const up = nextCompact(down, { top: 40 - COMPACT_STEP_PX, scrollable: long }, false);
    expect(up.compact).toBe(false);
  });

  test('small moves add up instead of flickering', () => {
    let s = nextCompact(full, { top: 3, scrollable: long }, false);
    expect(s).toEqual(full);
    s = nextCompact(s, { top: 6, scrollable: long }, false);
    expect(s.compact).toBe(false);
    s = nextCompact(s, { top: COMPACT_STEP_PX, scrollable: long }, false);
    expect(s.compact).toBe(true);
  });

  test('full size at the top, on a short page and under reduced motion', () => {
    const compact = { compact: true, anchor: 300 };
    expect(nextCompact(compact, { top: 0, scrollable: long }, false).compact).toBe(false);
    expect(
      nextCompact(full, { top: 60, scrollable: COMPACT_MIN_SCROLL_PX - 1 }, false).compact,
    ).toBe(false);
    expect(nextCompact(full, { top: 400, scrollable: long }, true).compact).toBe(false);
  });
});
