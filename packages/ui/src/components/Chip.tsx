import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../cn';
import { pillButtonClass } from './pill';

interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
}

export function Chip({ className, selected, children, ...rest }: ChipProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected || undefined}
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
      className={cn('flex gap-1.5 overflow-x-auto px-4 py-1.5 scrollbar-hide', className)}
    >
      {children}
    </div>
  );
}
