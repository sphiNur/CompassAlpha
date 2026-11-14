/**
 * Swiping between the bottom bar's tabs (owner, 2026-11-14, step 2 of the
 * nav redesign): the decisions behind SwipePager.tsx, pure so they are
 * tested without a browser.
 *
 *   - the ring: the bar's tabs in bar order (navLayout(...).bar). More is
 *     not in it, and a tab opened from More has no neighbours: swiping
 *     there does nothing. No wrap-around.
 *   - whether a touch may become a swipe: not from the Telegram back-swipe
 *     edge, a control that drags or scrolls sideways, a text field, a
 *     dialog; and only once it is clearly sideways.
 *   - where the page sits under the finger (resisting past the first and
 *     last tab), and whether letting go switches the tab or springs back.
 */

/** How far (px) a touch moves before it counts as a swipe or a scroll. */
export const SWIPE_SLOP_PX = 10;
/** The left and right screen edges (px) where iOS Telegram swipes back. */
export const SWIPE_EDGE_PX = 24;
/** The share of the width past which letting go switches the tab. */
export const SWITCH_FRACTION = 0.35;
/** A flick at least this fast (px/ms) switches before SWITCH_FRACTION. */
export const FLING_PX_PER_MS = 0.5;
/** …once the page has moved this far (px), so a twitch is not a flick. */
export const FLING_MIN_PX = 24;
/** The window (ms) of recent moves the release speed is measured over. */
export const VELOCITY_WINDOW_MS = 100;

export interface RingNeighbours<K> {
  prev: K | null;
  next: K | null;
}

/**
 * The tabs either side of `current` in the bar. A tab outside the bar (one
 * opened from More) has none.
 */
export function ringNeighbours<K>(ring: readonly K[], current: K): RingNeighbours<K> {
  const i = ring.indexOf(current);
  if (i < 0) return { prev: null, next: null };
  return { prev: i > 0 ? ring[i - 1]! : null, next: i < ring.length - 1 ? ring[i + 1]! : null };
}

/** What a swipe must not start on, for one element from the touch up. */
export interface TargetTraits {
  /** `data-no-swipe`: the kit's ChipBar, Segmented and QtyControl, or a page's own. */
  noSwipe?: boolean;
  /** input, textarea, select or contenteditable. */
  editable?: boolean;
  /** Scrolls sideways itself (overflow-x auto / scroll with more to show). */
  scrollsX?: boolean;
  /** A dialog (a sheet); they are portalled, so this is a safety net. */
  dialog?: boolean;
}

/** Whether a touch on this chain of elements (target first) is the page's to swipe. */
export function blockedByTarget(chain: readonly TargetTraits[]): boolean {
  return chain.some((t) => t.noSwipe || t.editable || t.scrollsX || t.dialog);
}

/** Within the edge zone where iOS Telegram's back swipe starts. */
export function inEdgeZone(x: number, width: number): boolean {
  return x < SWIPE_EDGE_PX || x > width - SWIPE_EDGE_PX;
}

const NON_TEXT_INPUTS = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/** A focused element that brings up the keyboard. */
export function isTextEntry(tag: string, type: string | null, contentEditable: boolean): boolean {
  if (contentEditable) return true;
  const t = tag.toLowerCase();
  if (t === 'textarea' || t === 'select') return true;
  return t === 'input' && !NON_TEXT_INPUTS.has((type ?? 'text').toLowerCase());
}

export interface StartContext {
  /** Where the touch went down (px from the screen's left). */
  x: number;
  /** The screen's width. */
  width: number;
  chain: readonly TargetTraits[];
  /** A dialog is open or a text field has focus. */
  busy: boolean;
  neighbours: RingNeighbours<unknown>;
}

/** Whether a touch going down here may become a swipe at all. */
export function mayStart(ctx: StartContext): boolean {
  if (ctx.busy) return false;
  if (ctx.neighbours.prev === null && ctx.neighbours.next === null) return false;
  if (inEdgeZone(ctx.x, ctx.width)) return false;
  return !blockedByTarget(ctx.chain);
}

export type StartVerdict = 'wait' | 'swipe' | 'ignore';

/**
 * After the touch has moved (dx, dy): too little to tell yet, clearly
 * sideways (a swipe), or not (a scroll, left to the browser).
 */
export function startVerdict(dx: number, dy: number): StartVerdict {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax <= SWIPE_SLOP_PX && ay <= SWIPE_SLOP_PX) return 'wait';
  return ax > ay ? 'swipe' : 'ignore';
}

/**
 * How far a page pulled `d` px past its last tab moves: less and less, as
 * on iOS, never more than `width`.
 */
export function rubberBand(d: number, width: number): number {
  if (width <= 0) return 0;
  const a = Math.abs(d);
  const moved = (1 - 1 / ((a * 0.55) / width + 1)) * width;
  return Math.sign(d) * moved;
}

/**
 * Where the page sits for a finger `dx` px from where the swipe began.
 * Moving left (dx < 0) brings the next tab in; with no tab that way, the
 * page resists.
 */
export function dragOffset(dx: number, width: number, n: RingNeighbours<unknown>): number {
  if (dx < 0) return n.next === null ? rubberBand(dx, width) : Math.max(dx, -width);
  if (dx > 0) return n.prev === null ? rubberBand(dx, width) : Math.min(dx, width);
  return 0;
}

export interface Sample {
  /** ms */
  t: number;
  x: number;
}

/** The finger's speed (px/ms, + is rightwards) over the last VELOCITY_WINDOW_MS. */
export function velocityOf(samples: readonly Sample[]): number {
  const last = samples[samples.length - 1];
  if (!last) return 0;
  let first = last;
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i]!;
    if (last.t - s.t > VELOCITY_WINDOW_MS) break;
    first = s;
  }
  const dt = last.t - first.t;
  return dt > 0 ? (last.x - first.x) / dt : 0;
}

export type ReleaseVerdict = 'prev' | 'next' | 'stay';

export interface ReleaseContext {
  /** The finger's distance from where the swipe began (px). */
  dx: number;
  width: number;
  /** px/ms, + is rightwards. */
  velocity: number;
  neighbours: RingNeighbours<unknown>;
}

/**
 * Letting go: past SWITCH_FRACTION of the width, or flicked that way, goes
 * to the neighbour; anything else springs back. A page pulled far but
 * flicked back stays.
 */
export function releaseVerdict({
  dx,
  width,
  velocity,
  neighbours,
}: ReleaseContext): ReleaseVerdict {
  if (dx === 0 || width <= 0) return 'stay';
  const toward: ReleaseVerdict = dx < 0 ? 'next' : 'prev';
  if (neighbours[toward] === null) return 'stay';
  const sameWay = Math.sign(velocity) === Math.sign(dx);
  const flick = Math.abs(velocity) >= FLING_PX_PER_MS;
  if (Math.abs(dx) >= width * SWITCH_FRACTION) return flick && !sameWay ? 'stay' : toward;
  return flick && sameWay && Math.abs(dx) >= FLING_MIN_PX ? toward : 'stay';
}

/** How long (ms) the page takes to cover the rest of its way. */
export function settleMs(remaining: number, width: number): number {
  if (width <= 0) return 0;
  const share = Math.min(1, Math.abs(remaining) / width);
  return Math.round(140 + 160 * share);
}

/**
 * Review MWB-13 (modern-web-guidance: swipe-to-reveal): a horizontal drag
 * stops the scroller's vertical scroll with `overflow-y: hidden` for the
 * rest of the gesture, instead of a non-passive `touchmove` that calls
 * preventDefault (which made every scroll start wait for the main thread).
 * The scroller's own inline value is kept and put back afterwards.
 */
export interface ScrollLock {
  /** The inline overflow-y before the lock, or null while unlocked. */
  saved: string | null;
}

export function lockScrollY(style: { overflowY: string }, lock: ScrollLock): void {
  if (lock.saved !== null) return;
  lock.saved = style.overflowY;
  style.overflowY = 'hidden';
}

export function unlockScrollY(style: { overflowY: string }, lock: ScrollLock): void {
  if (lock.saved === null) return;
  style.overflowY = lock.saved;
  lock.saved = null;
}
