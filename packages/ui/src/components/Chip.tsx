import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../cn';

interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
}

export function Chip({ className, selected, children, ...rest }: ChipProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected || undefined}
      className={cn(
        // `shrink-0 whitespace-nowrap` (added 2026-05-05) — without
        // them, the parent ChipBar's `flex` was squishing each chip
        // down to ~24px wide, which made longer category names wrap
        // char-by-char (CJK shows as a vertical column of single
        // characters; Cyrillic shows each word stacked). The bar is
        // already `overflow-x-auto`, so chips should KEEP their
        // natural width and the bar pans horizontally.
        // M2.4: pill text uniformly text-label (12 px) + font-medium —
        // matches Badge + RunPage history filter chip. Was text-body (14)
        // which created a 2 px jump against status badges in the same row.
        'press inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-[var(--r-pill)] px-4 text-label font-medium',
        selected
          ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
          : 'bg-transparent text-[var(--c-fg-muted)] ring-hairline',
        className,
      )}
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
}

export function ChipBar({ children, className, ariaLabel }: ChipBarProps) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      // overscroll-behavior: contain stops horizontal pulls from
      // bouncing the parent page on iOS — without it, a fast horizontal
      // chip-pan can briefly disable the page's vertical scroll.
      style={{ overscrollBehaviorX: 'contain' }}
      className={cn('flex gap-2 overflow-x-auto px-4 py-2 scrollbar-hide', className)}
    >
      {children}
    </div>
  );
}
