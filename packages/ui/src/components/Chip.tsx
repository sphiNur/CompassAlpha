import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../cn';
import { useRovingRadio } from '../rovingRadio';
import { pillButtonClass } from './pill';

/**
 * Chip semantics (2026-07-30).
 *
 * ChipBar/Chip started life as one thing — a single-select filter strip —
 * and got `role="tablist"` / `role="tab"` hardcoded. Two other patterns
 * then grew on top of the same primitive and inherited roles that don't
 * describe them:
 *
 *   (A 'tabs' variant — role=tablist / tab — was the default until
 *   A11Y-15, 2026-10-31. Nothing used it as real tabs: no tabpanels, no
 *   aria-controls, no arrow keys, and every chip a separate Tab stop. The
 *   order page's categories are a filter where exactly one is chosen, so
 *   they are a radio group now, which is also the new default.)
 *
 *   - 'toggles' Zero-or-one selected, and tapping the selected chip
 *               DESELECTS it. The run view-mode strip (按门店 / 按摊位 /
 *               按类型, M3.28) works this way on purpose: no chip lit
 *               means the editable aggregate view. As a tablist that read
 *               as "a tab group with nothing selected", which is invalid
 *               ARIA — assistive tech announces no chosen option rather
 *               than the real state. They are toggle buttons, so they now
 *               say `aria-pressed` inside a plain group.
 *
 *   - 'radio'   Single-select (the default). The order page's category
 *               filter (全部 / 蔬菜水果 / …, always one chosen), the run
 *               switcher, the receiving-page status chips (正常 / 数量不足
 *               / 物品错误 / 质量问题) where "nothing chosen yet" is a real,
 *               meaningful state after the 2026-07-30 fix that stopped
 *               defaulting undecided lines to 正常. A radiogroup with no
 *               checked radio is valid. One Tab stop, arrow keys between
 *               the chips (see rovingRadio.ts).
 *
 * The variant is declared once on ChipBar and reaches Chip through
 * context, so a call site can't set the container and its children to
 * disagree.
 */
export type ChipVariant = 'toggles' | 'radio';

const ChipVariantContext = createContext<ChipVariant>('radio');

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
}

export function Chip({ className, selected, children, ...rest }: ChipProps) {
  const variant = useContext(ChipVariantContext);
  // Pass the state boolean straight through rather than `selected ||
  // undefined`: the latter turned `false` into "attribute absent", so an
  // unselected chip carried no state at all and the group read as having
  // no selectable options.
  const semantics =
    variant === 'toggles'
      ? ({ role: undefined, 'aria-pressed': !!selected } as const)
      : ({ role: 'radio', 'aria-checked': !!selected, tabIndex: selected ? 0 : -1 } as const);
  return (
    <button
      type="button"
      {...semantics}
      // Pill visual (h-8 / --r-pill / text-old-label font-medium) lives
      // in pillButtonClass. Its `shrink-0
      // whitespace-nowrap` keep chips their natural width so the parent
      // ChipBar (overflow-x-auto) pans horizontally instead of squishing
      // each chip into a char-per-line column (CJK/Cyrillic). M2.4 text,
      // M3.15 h-8/px-3.
      className={cn(pillButtonClass(selected), className)}
      {...rest}
    >
      {children}
    </button>
  );
}

export interface ChipBarProps {
  children: ReactNode;
  className?: string;
  /**
   * What the chips choose or filter, announced to screen readers.
   * Required (review UI-21), as on Segmented: a group named only by its
   * chips says nothing about what they are for.
   */
  ariaLabel: string;
  /** See the ChipVariant docblock. Defaults to 'radio'. */
  variant?: ChipVariant;
  /**
   * Radio variant: an arrow key also chooses the chip it moves to
   * (default). Pass false where choosing does real work, so arrows only
   * move focus and Space / Enter chooses.
   */
  followFocus?: boolean;
  /**
   * The chips wrap onto more lines instead of scrolling sideways (a card
   * too narrow for them in ru / uz). Wrapped lines sit 12 px apart: the
   * chips are 32 px tall with a 44 px hit-44 area, and at the scroller's
   * 6 px gap each line's tap area overlapped the next, so the first line
   * tapped as 38 px (review WALK-03, 2026-11-13).
   */
  wrap?: boolean;
}

/**
 * Review MWC-05 / MWB-17 (V8, modern-web-guidance: scrollability-affordance-hints,
 * tabs): which ends of a sideways chip strip have chips beyond them. The
 * strip hides its scrollbar, so a soft fade at such an end is the cue that
 * it scrolls. Exported for tests.
 */
export function chipScrollEdges(r: {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
}): { start: boolean; end: boolean } {
  // 1 px slack: sub-pixel widths leave a strip a fraction short of its end.
  return {
    start: r.scrollLeft > 1,
    end: r.scrollLeft + r.clientWidth < r.scrollWidth - 1,
  };
}

/**
 * Review MWB-17 (V8): where the strip scrolls so the chosen chip is in
 * view, as `scrollIntoView({ block: 'nearest', inline: 'nearest' })` would
 * inside the strip: not at all when it is already in view (`pad` from
 * each edge, clear of the fade), else just far enough. Null: stay.
 * Done by hand because scrollIntoView also scrolls the page up or down to
 * the strip (`container: 'nearest'` is not in the WebViews yet), and a
 * strip lower on the page must not move the page when it mounts.
 * Exported for tests.
 */
export function nearestChipScroll(r: {
  chipStart: number;
  chipEnd: number;
  scrollLeft: number;
  clientWidth: number;
  pad: number;
}): number | null {
  const viewStart = r.scrollLeft + r.pad;
  const viewEnd = r.scrollLeft + r.clientWidth - r.pad;
  if (r.chipStart >= viewStart && r.chipEnd <= viewEnd) return null;
  // Wider than the view: its start wins.
  if (r.chipStart < viewStart || r.chipEnd - r.chipStart > viewEnd - viewStart) {
    return Math.max(0, r.chipStart - r.pad);
  }
  return r.chipEnd - r.clientWidth + r.pad;
}

/** The fade's reach, as in tokens.css (`.chip-scroll-fade`, 1.5rem). */
const FADE_REM = 1.5;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * V8: the strip's edge fades, and the chosen chip kept in view. The fades
 * follow the scroll in CSS where scroll-driven animations exist; elsewhere
 * (iOS before 26, older Android WebViews) this marks the ends itself.
 */
function useChipScroller(enabled: boolean) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const chosenRef = useRef<Element | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    const el = elRef.current;
    if (!enabled || !el) return;
    const css = typeof CSS !== 'undefined' ? CSS : undefined;
    if (css?.supports?.('animation-timeline: scroll()')) return;
    const mark = () => {
      const edges = chipScrollEdges(el);
      el.toggleAttribute('data-more-start', edges.start);
      el.toggleAttribute('data-more-end', edges.end);
    };
    mark();
    el.addEventListener('scroll', mark, { passive: true });
    const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(mark) : null;
    resize?.observe(el);
    // Chips come and go (categories load): the strip's width changes.
    const mutate = typeof MutationObserver !== 'undefined' ? new MutationObserver(mark) : null;
    mutate?.observe(el, { childList: true });
    return () => {
      el.removeEventListener('scroll', mark);
      resize?.disconnect();
      mutate?.disconnect();
    };
  }, [enabled]);

  // No dependency list: the chosen chip may change on any render.
  useLayoutEffect(() => {
    const el = elRef.current;
    if (!enabled || !el) return;
    const chosen = el.querySelector('[aria-checked="true"], [aria-pressed="true"]');
    const first = !mountedRef.current;
    mountedRef.current = true;
    if (chosen === chosenRef.current) return;
    chosenRef.current = chosen;
    if (!(chosen instanceof HTMLElement)) return;
    const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const left = nearestChipScroll({
      chipStart: chosen.offsetLeft,
      chipEnd: chosen.offsetLeft + chosen.offsetWidth,
      scrollLeft: el.scrollLeft,
      clientWidth: el.clientWidth,
      pad: FADE_REM * rootPx,
    });
    if (left === null) return;
    // At mount at once; on a change smoothly, unless motion is reduced.
    el.scrollTo?.({ left, behavior: first || prefersReducedMotion() ? 'auto' : 'smooth' });
  });

  return useCallback((el: HTMLDivElement | null) => {
    elRef.current = el;
  }, []);
}

export function ChipBar({
  children,
  className,
  ariaLabel,
  variant = 'radio',
  followFocus = true,
  wrap = false,
}: ChipBarProps) {
  const roving = useRovingRadio<HTMLDivElement>({ followFocus });
  const radio = variant === 'radio';
  const scrollerRef = useChipScroller(!wrap);
  const rovingRef = roving.ref;
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      scrollerRef(el);
      (rovingRef as { current: HTMLDivElement | null }).current = radio ? el : null;
    },
    [scrollerRef, rovingRef, radio],
  );
  return (
    <ChipVariantContext.Provider value={variant}>
      <div
        ref={setRef}
        onKeyDown={radio ? roving.onKeyDown : undefined}
        role={radio ? 'radiogroup' : 'group'}
        aria-label={ariaLabel}
        // A sideways drag here scrolls the chips, never swipes the tab.
        data-no-swipe=""
        // overscroll-behavior: contain stops horizontal pulls from
        // bouncing the parent page on iOS — without it, a fast horizontal
        // chip-pan can briefly disable the page's vertical scroll.
        style={{ overscrollBehaviorX: 'contain' }}
        // --app-inline-x (16 px): the page's side inset, as the list under
        // the strip (UI-34).
        className={cn(
          wrap
            ? 'flex flex-wrap gap-x-1.5 gap-y-3'
            : // V8 (MWC-05): chip-scroll-fade fades an end with chips beyond it.
              'chip-scroll-fade flex gap-1.5 overflow-x-auto px-[var(--app-inline-x)] py-1.5 scrollbar-hide',
          className,
        )}
      >
        {children}
      </div>
    </ChipVariantContext.Provider>
  );
}
