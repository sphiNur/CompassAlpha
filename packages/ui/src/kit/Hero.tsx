import type { ReactNode } from 'react';
import { cn } from '../cn';

export interface HeroProps {
  /** What the figure counts: "Waiting for you". */
  label: string;
  /** The one number this screen is about, already formatted. */
  figure: string;
  /** A line under it that says what it is made of. */
  note?: ReactNode;
  /** Extra content inside the block: a progress bar. */
  children?: ReactNode;
  className?: string;
  'data-testid'?: string;
}

/**
 * The block that carries a screen's most important number, in the
 * heaviest type and the strongest contrast on the page. One per screen
 * at most: two of them and neither is the most important.
 */
export function Hero({ label, figure, note, children, className, ...rest }: HeroProps) {
  return (
    <div
      data-testid={rest['data-testid']}
      data-hero
      className={cn('flex flex-col gap-xs rounded-lg bg-hero p-xl', className)}
    >
      <span className="text-small text-hero-text">{label}</span>
      <span className="text-display text-on-hero" dir="ltr">
        {figure}
      </span>
      {children}
      {note ? <span className="text-small text-hero-text">{note}</span> : null}
    </div>
  );
}
