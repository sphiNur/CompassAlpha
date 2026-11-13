import { createContext, useContext } from 'react';
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
  return (
    <ChipVariantContext.Provider value={variant}>
      <div
        ref={radio ? roving.ref : undefined}
        onKeyDown={radio ? roving.onKeyDown : undefined}
        role={radio ? 'radiogroup' : 'group'}
        aria-label={ariaLabel}
        // overscroll-behavior: contain stops horizontal pulls from
        // bouncing the parent page on iOS — without it, a fast horizontal
        // chip-pan can briefly disable the page's vertical scroll.
        style={{ overscrollBehaviorX: 'contain' }}
        // --app-inline-x (16 px): the page's side inset, as the list under
        // the strip (UI-34).
        className={cn(
          wrap
            ? 'flex flex-wrap gap-x-1.5 gap-y-3'
            : 'flex gap-1.5 overflow-x-auto px-[var(--app-inline-x)] py-1.5 scrollbar-hide',
          className,
        )}
      >
        {children}
      </div>
    </ChipVariantContext.Provider>
  );
}
