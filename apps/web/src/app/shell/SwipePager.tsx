/**
 * Swipe left / right between the bottom bar's neighbouring tabs, the page
 * following the finger (owner, 2026-11-14, step 2 of the nav redesign).
 * The bar stays the primary control; this is an extra. The decisions are
 * in swipeGesture.ts.
 *
 * What is on screen during a swipe: the open page (<main>, the one
 * scroller, moved with a transform) and, beside it, a still picture of the
 * neighbour: a copy of that page's DOM taken the last time it was left,
 * at the scroll position it was left at, or the kit's LoadingState when
 * it has not been opened yet. Only the open page is mounted. A second
 * live page would register its main button, page menu, Telegram back
 * button and leave guards, and run its queries and realtime work, all of
 * which assume one page; the copy runs nothing. Letting go past the
 * threshold switches through the same path as a tap on the tab (guards,
 * store, deep links), and the neighbour's page mounts from its prefetched
 * chunk and cached data.
 *
 * The copy is in the document only while a swipe moves (inert, hidden
 * from assistive tech, ids and test ids stripped), never at rest.
 *
 * Reduced motion: nothing follows the finger; a swipe that would switch
 * switches at once when the finger lifts.
 *
 * Touch and pen only: a mouse drag on a desktop selects text.
 */
import { LoadingState } from '@compass/ui';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { useNavStore, type Tab } from '../../stores/navStore';
import { preloadPage } from '../pageChunks';
import {
  dragOffset,
  isTextEntry,
  lockScrollY,
  mayStart,
  releaseVerdict,
  ringNeighbours,
  settleMs,
  startVerdict,
  unlockScrollY,
  velocityOf,
  type Sample,
  type ScrollLock,
  type TargetTraits,
} from './swipeGesture';

interface Snapshot {
  node: HTMLElement;
  scrollTop: number;
}

type Side = 'prev' | 'next';

export interface SwipePagerProps {
  /** The bar's tabs in bar order (navLayout(...).bar); empty: no swiping. */
  ring: readonly Tab[];
  tab: Tab;
  mainRef: RefObject<HTMLElement | null>;
  /** Switch as a tap on the tab does; resolves false when a guard said no. */
  onSwipe: (next: Tab) => Promise<boolean>;
  /** The pictures of other tabs are dropped when this changes (store, language). */
  resetKey: string;
  children: ReactNode;
}

/** A copy of <main>'s content that runs nothing and clashes with nothing. */
function takeSnapshot(main: HTMLElement): Snapshot {
  const node = document.createElement('div');
  for (const child of Array.from(main.children)) node.append(child.cloneNode(true));
  node.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
  node.querySelectorAll('[data-testid]').forEach((el) => el.removeAttribute('data-testid'));
  node.querySelectorAll('[autofocus]').forEach((el) => el.removeAttribute('autofocus'));
  // A copied checked radio with the same name would uncheck the real one.
  node.querySelectorAll('[name]').forEach((el) => el.removeAttribute('name'));
  node.querySelectorAll('[aria-live]').forEach((el) => el.removeAttribute('aria-live'));
  return { node, scrollTop: main.scrollTop };
}

function traitsOf(el: Element): TargetTraits {
  const tag = el.tagName.toLowerCase();
  const html = el as HTMLElement;
  let scrollsX = false;
  if (html.scrollWidth > html.clientWidth) {
    const ox = getComputedStyle(html).overflowX;
    scrollsX = ox === 'auto' || ox === 'scroll';
  }
  const role = el.getAttribute('role');
  return {
    noSwipe: el.hasAttribute('data-no-swipe'),
    editable:
      tag === 'input' || tag === 'textarea' || tag === 'select' || html.isContentEditable === true,
    scrollsX,
    dialog: role === 'dialog' || role === 'alertdialog',
  };
}

/** The touched element and its parents up to (not including) the pager. */
function chainOf(target: EventTarget | null, root: HTMLElement): TargetTraits[] {
  const out: TargetTraits[] = [];
  let el = target instanceof Element ? target : null;
  while (el && el !== root) {
    out.push(traitsOf(el));
    el = el.parentElement;
  }
  return out;
}

/** A sheet or dialog is open, or a text field has the keyboard up. */
function appBusy(): boolean {
  if (
    document.querySelector(
      '[role="dialog"]:not([data-state="closed"]), [role="alertdialog"]:not([data-state="closed"])',
    )
  ) {
    return true;
  }
  const a = document.activeElement as HTMLElement | null;
  return (
    !!a &&
    isTextEntry(a.tagName, a.getAttribute('type'), a.isContentEditable === true) &&
    a !== document.body
  );
}

function reducedMotion(): boolean {
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function SwipePager({ ring, tab, mainRef, onSwipe, resetKey, children }: SwipePagerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // The side the picture is drawn on, or null: the only state, so a drag
  // re-renders the pager when it starts and turns, never per move.
  const [preview, setPreview] = useState<Side | null>(null);
  const snapshots = useRef(new Map<Tab, Snapshot>());
  const latest = useRef({ ring, tab, onSwipe });
  latest.current = { ring, tab, onSwipe };
  const { prev, next } = ringNeighbours(ring, tab);
  const neighbourOf = (side: Side): Tab | null => (side === 'prev' ? prev : next);

  // Drop the pictures when they would show another store or language.
  useEffect(() => {
    snapshots.current.clear();
  }, [resetKey]);

  // Picture the page being left, whichever way it is left (a tap, a link,
  // a swipe): the store calls this before React draws the next page.
  useEffect(
    () =>
      useNavStore.subscribe((s, before) => {
        if (s.tab === before.tab) return;
        const leaving = latest.current.tab;
        const main = mainRef.current;
        if (!main || !latest.current.ring.includes(leaving)) return;
        snapshots.current.set(leaving, takeSnapshot(main));
      }),
    [mainRef],
  );

  // Warm the neighbours' chunks so a swipe never lands on a spinner.
  useEffect(() => {
    const keys = [prev, next].filter((k): k is Tab => k !== null);
    if (keys.length === 0) return;
    const id = setTimeout(() => keys.forEach((k) => void preloadPage(k)), 300);
    return () => clearTimeout(id);
  }, [prev, next]);

  const gesture = useRef({
    phase: 'idle' as 'idle' | 'pending' | 'drag' | 'settle',
    pointerId: -1,
    x0: 0,
    y0: 0,
    dx: 0,
    width: 0,
    still: false,
    side: null as Side | null,
    samples: [] as Sample[],
    frame: 0,
    suppressClickUntil: 0,
  });
  // Review MWB-13 (modern-web-guidance: swipe-to-reveal): <main>'s inline
  // overflow-y while a drag holds its vertical scroll.
  const scrollLock = useRef<ScrollLock>({ saved: null });

  const clearStyles = useCallback(() => {
    const main = mainRef.current;
    if (main) {
      main.style.transform = '';
      main.style.transition = '';
      main.style.willChange = '';
      unlockScrollY(main.style, scrollLock.current);
    }
  }, [mainRef]);

  const place = useCallback(
    (offset: number, ms: number) => {
      const g = gesture.current;
      const main = mainRef.current;
      const panel = panelRef.current;
      const transition = ms > 0 ? `transform ${ms}ms var(--easing, ease-out)` : '';
      if (main) {
        main.style.transition = transition;
        main.style.transform = offset === 0 && ms === 0 ? '' : `translate3d(${offset}px,0,0)`;
      }
      if (panel) {
        const base = g.side === 'next' ? g.width : -g.width;
        panel.style.transition = transition;
        panel.style.transform = `translate3d(${offset + base}px,0,0)`;
      }
    },
    [mainRef],
  );

  // The page changed (a swipe landed, or a tap mid-swipe): the new page
  // sits in place and the picture goes, before the browser paints.
  useLayoutEffect(() => {
    const g = gesture.current;
    cancelAnimationFrame(g.frame);
    g.phase = 'idle';
    g.side = null;
    clearStyles();
    setPreview(null);
  }, [tab, clearStyles]);

  // Fill the picture when it appears or changes side.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel || !preview) return;
    panel.setAttribute('inert', '');
    const key = neighbourOf(preview);
    const snap = key ? snapshots.current.get(key) : undefined;
    const host = panel.querySelector<HTMLElement>('[data-swipe-snapshot]');
    if (host && snap) {
      host.replaceChildren(snap.node);
      panel.scrollTop = snap.scrollTop;
    }
    const g = gesture.current;
    place(dragOffset(g.dx, g.width, { prev, next }), 0);
    // neighbourOf and prev / next change only with the tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, place]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const g = gesture.current;
    const neighbours = () => ringNeighbours(latest.current.ring, latest.current.tab);

    const springBack = () => {
      if (g.still) {
        g.phase = 'idle';
        clearStyles();
        return;
      }
      const offset = dragOffset(g.dx, g.width, neighbours());
      g.phase = 'settle';
      const ms = settleMs(offset, g.width);
      place(0, ms);
      window.setTimeout(() => {
        if (g.phase !== 'settle') return;
        g.phase = 'idle';
        g.side = null;
        clearStyles();
        setPreview(null);
      }, ms + 20);
    };

    const finish = (side: Side) => {
      const target = neighbours()[side];
      if (!target) return springBack();
      g.phase = 'settle';
      if (g.still) {
        // Reduced motion: the page never moved; switch at once.
        void latest.current.onSwipe(target).then((allowed) => {
          if (!allowed && g.phase === 'settle') {
            g.phase = 'idle';
            clearStyles();
          }
        });
        return;
      }
      const offset = dragOffset(g.dx, g.width, neighbours());
      const end = side === 'next' ? -g.width : g.width;
      const ms = settleMs(end - offset, g.width);
      place(end, ms);
      window.setTimeout(() => {
        if (g.phase !== 'settle') return;
        void latest.current.onSwipe(target).then((allowed) => {
          // Allowed: the tab effect above resets everything.
          if (!allowed && g.phase === 'settle') springBack();
        });
      }, ms + 20);
    };

    const onDown = (e: PointerEvent) => {
      if (!e.isPrimary || e.pointerType === 'mouse' || g.phase !== 'idle') return;
      const ok = mayStart({
        x: e.clientX,
        width: window.innerWidth,
        chain: chainOf(e.target, root),
        busy: appBusy(),
        neighbours: neighbours(),
      });
      if (!ok) return;
      g.phase = 'pending';
      g.pointerId = e.pointerId;
      g.x0 = e.clientX;
      g.y0 = e.clientY;
      g.dx = 0;
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== g.pointerId) return;
      if (g.phase === 'pending') {
        const verdict = startVerdict(e.clientX - g.x0, e.clientY - g.y0);
        if (verdict === 'wait') return;
        if (verdict === 'ignore') {
          g.phase = 'idle';
          return;
        }
        g.phase = 'drag';
        // Start from here, so the page does not jump by the slop.
        g.x0 = e.clientX;
        g.width = root.clientWidth;
        g.still = reducedMotion();
        g.samples = [];
        try {
          root.setPointerCapture(e.pointerId);
        } catch {
          /* the pointer is already gone */
        }
        const main = mainRef.current;
        // Review MWB-13 (modern-web-guidance: swipe-to-reveal): from here
        // the gesture is sideways, so <main> stops scrolling vertically
        // until the drag's styles are cleared (release, cancel, unmount).
        // Reduced motion too: the page does not move, but must not scroll.
        if (main) lockScrollY(main.style, scrollLock.current);
        if (main && !g.still) main.style.willChange = 'transform';
      }
      if (g.phase !== 'drag') return;
      g.dx = e.clientX - g.x0;
      g.samples.push({ t: e.timeStamp, x: e.clientX });
      if (g.samples.length > 20) g.samples.shift();
      if (g.still) return;
      const n = neighbours();
      const side: Side | null = g.dx < 0 && n.next ? 'next' : g.dx > 0 && n.prev ? 'prev' : null;
      if (side !== g.side) {
        g.side = side;
        setPreview(side);
      }
      cancelAnimationFrame(g.frame);
      g.frame = requestAnimationFrame(() => {
        if (g.phase === 'drag') place(dragOffset(g.dx, g.width, neighbours()), 0);
      });
    };

    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== g.pointerId) return;
      if (g.phase === 'pending') {
        g.phase = 'idle';
        return;
      }
      if (g.phase !== 'drag') return;
      cancelAnimationFrame(g.frame);
      g.suppressClickUntil = e.timeStamp + 400;
      const verdict = releaseVerdict({
        dx: g.dx,
        width: g.width,
        velocity: velocityOf(g.samples),
        neighbours: neighbours(),
      });
      if (verdict === 'stay') springBack();
      else finish(verdict);
    };

    const onCancel = (e: PointerEvent) => {
      if (e.pointerId !== g.pointerId) return;
      if (g.phase === 'pending') g.phase = 'idle';
      else if (g.phase === 'drag') {
        cancelAnimationFrame(g.frame);
        springBack();
      }
    };

    // A drag that ends over a button is not a tap on it.
    const onClick = (e: MouseEvent) => {
      if (e.timeStamp < g.suppressClickUntil) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    root.addEventListener('pointerdown', onDown);
    root.addEventListener('pointermove', onMove);
    root.addEventListener('pointerup', onUp);
    root.addEventListener('pointercancel', onCancel);
    root.addEventListener('click', onClick, true);
    return () => {
      cancelAnimationFrame(g.frame);
      clearStyles();
      root.removeEventListener('pointerdown', onDown);
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerup', onUp);
      root.removeEventListener('pointercancel', onCancel);
      root.removeEventListener('click', onClick, true);
    };
  }, [mainRef, place, clearStyles]);

  const previewKey = preview ? neighbourOf(preview) : null;
  const hasSnapshot = previewKey !== null && snapshots.current.has(previewKey);
  return (
    <div
      ref={rootRef}
      data-swipe-pager=""
      // overflow-x: clip, not hidden: the pages beside stay out of view
      // without making this a scroller that scrollIntoView could move.
      className="relative flex min-h-0 flex-1 flex-col overflow-x-clip"
    >
      {children}
      {preview && previewKey ? (
        <div
          ref={panelRef}
          aria-hidden
          // Laid out as <main> is (Shell.tsx), so the picture lines up.
          className="app-main pointer-events-none absolute inset-0 overflow-hidden bg-[var(--c-bg)]"
          style={{
            paddingLeft: 'var(--app-safe-left, 0px)',
            paddingRight: 'var(--app-safe-right, 0px)',
            transform: `translate3d(${preview === 'next' ? '100%' : '-100%'},0,0)`,
          }}
        >
          {/* Review MWB-09: a hidden picture, so it says nothing. */}
          {hasSnapshot ? <div data-swipe-snapshot="" /> : <LoadingState announce={false} />}
        </div>
      ) : null}
    </div>
  );
}
