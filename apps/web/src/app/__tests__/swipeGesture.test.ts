import { describe, expect, test } from 'bun:test';
import { BUILTIN_ROLES } from '@compass/db/seed-data';
import { navLayout } from '../shell/navLayout';
import {
  blockedByTarget,
  dragOffset,
  FLING_PX_PER_MS,
  inEdgeZone,
  isTextEntry,
  lockScrollY,
  mayStart,
  releaseVerdict,
  ringNeighbours,
  rubberBand,
  type ScrollLock,
  settleMs,
  startVerdict,
  SWIPE_EDGE_PX,
  SWIPE_SLOP_PX,
  unlockScrollY,
  velocityOf,
} from '../shell/swipeGesture';
import { visibleTabsFor } from '../shell/tabs';

const W = 390;
const both = { prev: 'order', next: 'settlement' } as const;
const firstTab = { prev: null, next: 'approve' } as const;
const lastTab = { prev: 'settlement', next: null } as const;
const none = { prev: null, next: null } as const;

describe('ringNeighbours', () => {
  const ring = ['order', 'approve', 'settlement', 'confirm'];
  test('the tabs either side, no wrap-around', () => {
    expect(ringNeighbours(ring, 'order')).toEqual({ prev: null, next: 'approve' });
    expect(ringNeighbours(ring, 'approve')).toEqual({ prev: 'order', next: 'settlement' });
    expect(ringNeighbours(ring, 'confirm')).toEqual({ prev: 'settlement', next: null });
  });
  test('a tab opened from More has none', () => {
    expect(ringNeighbours(ring, 'history')).toEqual(none);
  });
  test('one tab, or none: nowhere to go', () => {
    expect(ringNeighbours(['order'], 'order')).toEqual(none);
    expect(ringNeighbours([], 'order')).toEqual(none);
  });
  test("a store manager's ring is the bar: Order next to Review, History and Admin behind More", () => {
    const manager = BUILTIN_ROLES.find((r) => r.slug === 'manager')!.permissions;
    const { bar } = navLayout(visibleTabsFor(manager, undefined, false), manager);
    const ring = bar.map((t) => t.key);
    expect(ring).toEqual(['order', 'approve', 'settlement', 'confirm']);
    expect(ringNeighbours(ring, 'order').next).toBe('approve');
    expect(ringNeighbours(ring, 'admin')).toEqual(none);
  });
});

describe('where a swipe may start', () => {
  const ok = { x: 200, width: W, chain: [{}, {}], busy: false, neighbours: both };
  test('on plain page content', () => {
    expect(mayStart(ok)).toBe(true);
  });
  test('not in the Telegram back-swipe edges', () => {
    expect(inEdgeZone(SWIPE_EDGE_PX - 1, W)).toBe(true);
    expect(inEdgeZone(W - SWIPE_EDGE_PX + 1, W)).toBe(true);
    expect(inEdgeZone(SWIPE_EDGE_PX + 1, W)).toBe(false);
    expect(mayStart({ ...ok, x: 10 })).toBe(false);
    expect(mayStart({ ...ok, x: W - 10 })).toBe(false);
  });
  test('not on anything that drags, scrolls sideways or takes typing', () => {
    expect(blockedByTarget([{}, { noSwipe: true }, {}])).toBe(true);
    expect(blockedByTarget([{ editable: true }])).toBe(true);
    expect(blockedByTarget([{}, { scrollsX: true }])).toBe(true);
    expect(blockedByTarget([{ dialog: true }])).toBe(true);
    expect(blockedByTarget([{}, {}])).toBe(false);
    expect(mayStart({ ...ok, chain: [{}, { noSwipe: true }] })).toBe(false);
  });
  test('not while a dialog is open or the keyboard is up', () => {
    expect(mayStart({ ...ok, busy: true })).toBe(false);
  });
  test('not where there is no neighbour at all', () => {
    expect(mayStart({ ...ok, neighbours: none })).toBe(false);
    expect(mayStart({ ...ok, neighbours: firstTab })).toBe(true);
  });
  test('text entry: fields that bring up the keyboard', () => {
    expect(isTextEntry('INPUT', null, false)).toBe(true);
    expect(isTextEntry('input', 'number', false)).toBe(true);
    expect(isTextEntry('input', 'search', false)).toBe(true);
    expect(isTextEntry('TEXTAREA', null, false)).toBe(true);
    expect(isTextEntry('div', null, true)).toBe(true);
    expect(isTextEntry('input', 'checkbox', false)).toBe(false);
    expect(isTextEntry('button', null, false)).toBe(false);
  });
});

describe('startVerdict', () => {
  test('waits inside the slop', () => {
    expect(startVerdict(0, 0)).toBe('wait');
    expect(startVerdict(SWIPE_SLOP_PX, -SWIPE_SLOP_PX)).toBe('wait');
  });
  test('clearly sideways is a swipe, either way', () => {
    expect(startVerdict(SWIPE_SLOP_PX + 2, 3)).toBe('swipe');
    expect(startVerdict(-20, 8)).toBe('swipe');
  });
  test('mostly vertical, or diagonal, is left to the scroll', () => {
    expect(startVerdict(4, 14)).toBe('ignore');
    expect(startVerdict(15, -15)).toBe('ignore');
  });
});

describe('dragOffset', () => {
  test('follows the finger toward a neighbour, at most a width', () => {
    expect(dragOffset(-120, W, both)).toBe(-120);
    expect(dragOffset(80, W, both)).toBe(80);
    expect(dragOffset(-900, W, both)).toBe(-W);
  });
  test('resists past the first and the last tab', () => {
    const pulled = dragOffset(150, W, firstTab);
    expect(pulled).toBeGreaterThan(0);
    expect(pulled).toBeLessThan(75);
    expect(dragOffset(-150, W, lastTab)).toBeCloseTo(-pulled, 6);
    // More pull, more distance, never the whole width.
    expect(rubberBand(300, W)).toBeGreaterThan(rubberBand(150, W));
    expect(rubberBand(1e6, W)).toBeLessThan(W);
  });
});

describe('velocityOf', () => {
  test('px/ms over the last 100 ms', () => {
    const s = [
      { t: 0, x: 300 },
      { t: 200, x: 290 },
      { t: 250, x: 240 },
      { t: 300, x: 190 },
    ];
    expect(velocityOf(s)).toBeCloseTo(-1, 6);
  });
  test('no samples or one: still', () => {
    expect(velocityOf([])).toBe(0);
    expect(velocityOf([{ t: 1, x: 5 }])).toBe(0);
  });
});

describe('releaseVerdict', () => {
  const slow = 0.05;
  test('past 35% of the width switches toward the neighbour', () => {
    expect(releaseVerdict({ dx: -0.4 * W, width: W, velocity: -slow, neighbours: both })).toBe(
      'next',
    );
    expect(releaseVerdict({ dx: 0.4 * W, width: W, velocity: 0, neighbours: both })).toBe('prev');
  });
  test('short of it, springs back', () => {
    expect(releaseVerdict({ dx: -0.3 * W, width: W, velocity: -slow, neighbours: both })).toBe(
      'stay',
    );
  });
  test('a flick switches early', () => {
    const v = FLING_PX_PER_MS + 0.1;
    expect(releaseVerdict({ dx: -60, width: W, velocity: -v, neighbours: both })).toBe('next');
    expect(releaseVerdict({ dx: 60, width: W, velocity: v, neighbours: both })).toBe('prev');
    // A twitch is not a flick.
    expect(releaseVerdict({ dx: -8, width: W, velocity: -v, neighbours: both })).toBe('stay');
  });
  test('pulled far but flicked back stays', () => {
    const v = FLING_PX_PER_MS + 0.1;
    expect(releaseVerdict({ dx: -0.5 * W, width: W, velocity: v, neighbours: both })).toBe('stay');
  });
  test('no neighbour that way: stays, however far', () => {
    expect(releaseVerdict({ dx: 0.9 * W, width: W, velocity: 2, neighbours: firstTab })).toBe(
      'stay',
    );
    expect(releaseVerdict({ dx: -0.9 * W, width: W, velocity: -2, neighbours: lastTab })).toBe(
      'stay',
    );
  });
  test('no move, no switch', () => {
    expect(releaseVerdict({ dx: 0, width: W, velocity: -3, neighbours: both })).toBe('stay');
  });
});

test('settleMs: the further to go, the longer, within bounds', () => {
  expect(settleMs(0, W)).toBe(140);
  expect(settleMs(W, W)).toBe(300);
  expect(settleMs(-2 * W, W)).toBe(300);
  expect(settleMs(W / 2, W)).toBeGreaterThan(settleMs(W / 4, W));
});

describe('the scroll lock during a drag (MWB-13)', () => {
  test('locks once, keeps the inline value and puts it back', () => {
    const style = { overflowY: 'scroll' };
    const lock: ScrollLock = { saved: null };
    lockScrollY(style, lock);
    expect(style.overflowY).toBe('hidden');
    lockScrollY(style, lock);
    expect(lock.saved).toBe('scroll');
    unlockScrollY(style, lock);
    expect(style.overflowY).toBe('scroll');
    expect(lock.saved).toBeNull();
  });
  test('an empty inline value comes back empty; unlocking twice changes nothing', () => {
    const style = { overflowY: '' };
    const lock: ScrollLock = { saved: null };
    lockScrollY(style, lock);
    unlockScrollY(style, lock);
    expect(style.overflowY).toBe('');
    style.overflowY = 'auto';
    unlockScrollY(style, lock);
    expect(style.overflowY).toBe('auto');
  });
});
