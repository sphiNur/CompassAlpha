import { useId, useState, type ReactNode } from 'react';
import { cn } from '../cn';
import { surfaceClass } from './Card';
import { IconChevronRight } from './NavIcon';

/**
 * A titled block that opens on a tap: the day's sales and a close's
 * history on the daily close page. Review CONF-11 (2026-11-11): each was
 * written by hand, one grey and one white, one arrow ▾/▸ and one › turned.
 *
 * The content is drawn only while open, so what it loads waits until the
 * block is opened. Pass `open` and `onOpenChange` to keep the state above
 * a parent that is drawn again from scratch.
 */
export interface DisclosureProps {
  title: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

export function Disclosure({ title, children, open, onOpenChange, className }: DisclosureProps) {
  const [ownOpen, setOwnOpen] = useState(false);
  const shown = open ?? ownOpen;
  const contentId = useId();
  return (
    <section className={cn('flex flex-col gap-2', className)}>
      <button
        type="button"
        aria-expanded={shown}
        aria-controls={shown ? contentId : undefined}
        onClick={() => {
          if (open === undefined) setOwnOpen(!shown);
          onOpenChange?.(!shown);
        }}
        className={cn(
          surfaceClass,
          'press flex w-full items-center justify-between gap-3 px-4 py-3 text-left',
        )}
      >
        <span className="min-w-0 text-old-body font-semibold text-[var(--c-fg)]">{title}</span>
        <span
          aria-hidden
          className={cn(
            'shrink-0 text-[var(--c-fg-subtle)] transition-transform motion-reduce:transition-none',
            shown && 'rotate-90',
          )}
        >
          <IconChevronRight size={18} />
        </span>
      </button>
      {shown ? <div id={contentId}>{children}</div> : null}
    </section>
  );
}
