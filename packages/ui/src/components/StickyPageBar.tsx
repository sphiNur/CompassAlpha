import type { ReactNode } from 'react';
import { cn } from '../cn';

/**
 * StickyPageBar — the page's sticky top strip: the SearchInput+ChipBar
 * on Order, the Tabs on Approval, the run-date on Confirm/Run.
 *
 * Owns the chrome that was copy-pasted verbatim into 4 pages: `sticky
 * top-0 z-[1]` + `border-b divider` + `bg-bg` + `px-4 py-2`.
 *
 * It used to also carry inline `--app-chrome-pad-*` padding to clear
 * Telegram's Close / ⋯ buttons. Removed 2026-07-30: those buttons
 * overlay the RESERVED STRIP that Shell renders above `<main>`, and
 * this bar renders below that strip — it was never underneath them.
 * The padding bought nothing and cost a lot: on a 392-px Telegram
 * viewport it inset the search field and category chips 56px/96px
 * while the SKU rows immediately beneath used px-4, so the filters sat
 * 40px/80px narrower than the list they filter and the chip row was
 * clipped mid-character on the right. Clearing the chrome is the
 * strip's job (see Shell.tsx); everything below it is ordinary page
 * content and uses ordinary page padding.
 *
 * `direction`:
 *   - 'row' (default) — horizontal `items-center` strip (Confirm/Run
 *     run-date + toggles). Pass a min-height via `className` if the
 *     strip must reserve height when its content is short.
 *   - 'col' — stacked (Order's SearchInput over ChipBar, Approval's
 *     Tabs).
 *
 * See FRONTEND_AUDIT_2026-07.md (T2 primitive-gap: sticky top strip).
 */
export interface StickyPageBarProps {
  children: ReactNode;
  direction?: 'row' | 'col';
  className?: string;
}

export function StickyPageBar({ children, direction = 'row', className }: StickyPageBarProps) {
  return (
    <div
      className={cn(
        'sticky top-0 z-[1] border-b border-[var(--c-divider)] bg-[var(--c-bg)] px-4 py-2',
        direction === 'col' ? 'flex flex-col gap-2' : 'flex items-center gap-2',
        className,
      )}
    >
      {children}
    </div>
  );
}
