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
      // `selected || undefined` turned false into "attribute absent",
      // so an UNSELECTED chip carried no aria-selected at all. Inside a
      // tablist that is invalid — every tab must state its selection —
      // and assistive tech reads the group as having no selectable
      // options rather than one chosen out of several. React already
      // omits the attribute for undefined, so passing the boolean
      // straight through is both the fix and the simpler code.
      aria-selected={selected}
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
