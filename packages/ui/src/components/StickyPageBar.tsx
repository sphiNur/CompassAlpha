import type { ReactNode } from 'react';
import { cn } from '../cn';

/**
 * StickyPageBar — the page's sticky top strip: the SearchInput+ChipBar
 * on Order, the Tabs on Approval, the run-date on Confirm/Run.
 *
 * Owns the chrome that was copy-pasted verbatim into 4 pages: `sticky
 * top-0 z-[1]` + `border-b divider` + `bg-bg` + `py-2`, AND the
 * load-bearing inline padding that clears Telegram's overlay chrome
 * buttons (Close at left, ⋯ at right) via the `--app-chrome-pad-*`
 * vars Shell sets at runtime. That wiring must stay in ONE place — a
 * per-page copy is a bug waiting to drift (and it already had, on
 * min-height: 7 vs 9 vs none).
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
        'sticky top-0 z-[1] border-b border-[var(--c-divider)] bg-[var(--c-bg)] py-2',
        direction === 'col' ? 'flex flex-col gap-2' : 'flex items-center gap-2',
        className,
      )}
      style={{
        // Clear Telegram's overlay chrome (Close at left, ⋯ at right).
        // Vars set by Shell's chrome detection; default 16px so
        // non-Telegram / web-preview keeps the legacy px-4 look.
        paddingLeft: 'max(16px, var(--app-chrome-pad-left, 16px))',
        paddingRight: 'max(16px, var(--app-chrome-pad-right, 16px))',
      }}
    >
      {children}
    </div>
  );
}
