import { createContext, useContext } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../cn';
import { pillButtonClass } from './pill';

/**
 * Chip semantics (2026-07-30).
 *
 * ChipBar/Chip started life as one thing — a single-select filter strip —
 * and got `role="tablist"` / `role="tab"` hardcoded. Two other patterns
 * then grew on top of the same primitive and inherited roles that don't
 * describe them:
 *
 *   - 'tabs'    Single-select, always exactly one selected. Order page
 *               categories (全部 / 蔬菜水果 / …). The original case;
 *               stays the default so existing call sites are unchanged.
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
 *   - 'radio'   Single-select where "nothing chosen yet" is a real,
 *               meaningful state. The receiving-page status chips
 *               (正常 / 数量不足 / 物品错误 / 质量问题) after the
 *               2026-07-30 fix that stopped defaulting undecided lines to
 *               正常. A radiogroup with no checked radio is valid; a
 *               tablist with no selected tab is not.
 *
 * The variant is declared once on ChipBar and reaches Chip through
 * context, so a call site can't set the container and its children to
 * disagree.
 */
export type ChipVariant = 'tabs' | 'toggles' | 'radio';

const ChipVariantContext = createContext<ChipVariant>('tabs');

interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
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
      : variant === 'radio'
        ? ({ role: 'radio', 'aria-checked': !!selected } as const)
        : ({ role: 'tab', 'aria-selected': !!selected } as const);
  return (
    <button
      type="button"
      {...semantics}
      // Pill visual (h-8 / rounded-pill / text-label font-medium) lives
      // in pillButtonClass, shared with Tab. Its `shrink-0
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

interface ChipBarProps {
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
  /** See the ChipVariant docblock. Defaults to 'tabs' (legacy behaviour). */
  variant?: ChipVariant;
}

export function ChipBar({ children, className, ariaLabel, variant = 'tabs' }: ChipBarProps) {
  const role = variant === 'toggles' ? 'group' : variant === 'radio' ? 'radiogroup' : 'tablist';
  return (
    <ChipVariantContext.Provider value={variant}>
      <div
        role={role}
        aria-label={ariaLabel}
        // overscroll-behavior: contain stops horizontal pulls from
        // bouncing the parent page on iOS — without it, a fast horizontal
        // chip-pan can briefly disable the page's vertical scroll.
        style={{ overscrollBehaviorX: 'contain' }}
        className={cn('flex gap-1.5 overflow-x-auto px-4 py-1.5 scrollbar-hide', className)}
      >
        {children}
      </div>
    </ChipVariantContext.Provider>
  );
}
