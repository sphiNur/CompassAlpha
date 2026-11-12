import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../cn';

/**
 * The one definition of the Concord "card surface": rounded-card +
 * surface fill + hairline ring. Compose this everywhere a card/row/tile
 * needs the surface look instead of re-typing the trio (it was
 * independently re-declared in Card, SectionRow, ListRow and Tile —
 * five owners guaranteed drift on any tweak). Change the surface once,
 * here (2026-07 frontend audit).
 */
export const surfaceClass = 'rounded-[var(--r-card)] bg-[var(--c-surface)] ring-hairline';

/**
 * Rows divided by hairlines, with no surface of their own: a list that
 * already sits inside a card (UI-13: no card inside a card). Review
 * ADM2-12 (2026-11-11).
 */
export const rowListClass = 'flex flex-col divide-y divide-[var(--c-divider)]';

/**
 * UI-6 / UI-13 (2026-11-05): a list of rows is ONE card with hairline
 * dividers, not a stack of cards. Put this on the <ul>/<div> that holds
 * `SectionRow` / `ListRow` children (they carry no surface of their own).
 */
export const rowGroupClass = `${rowListClass} overflow-hidden ${surfaceClass}`;

export interface CardProps extends HTMLAttributes<HTMLElement> {
  interactive?: boolean;
  // 'li' (A11Y-14): a card that is an item of a <ul role="list">.
  as?: 'div' | 'section' | 'article' | 'li';
}

export function Card({ className, interactive, as: As = 'div', ...rest }: CardProps) {
  return (
    <As
      className={cn('min-w-0', surfaceClass, interactive && 'press cursor-pointer', className)}
      {...rest}
    />
  );
}

export function CardHeader({ className, children }: { className?: string; children: ReactNode }) {
  return (
    // M3.16 (2026-05-16): pt-4 → pt-3. Combined with the M3.15 row-padding
    // cuts, admin Cards (Categories, Stores, Members) now read at the
    // same density as the bottom nav. The header still has no bottom
    // padding because consumers either follow it with a button row
    // (which carries its own py-2) or end the card right after.
    <header className={cn('flex items-start justify-between gap-3 px-4 pt-3', className)}>
      {children}
    </header>
  );
}

export function CardTitle({
  className,
  children,
  as: As = 'h3',
}: {
  className?: string;
  children: ReactNode;
  /** A11Y-10: h2 for cards right under the page's <h1> (a list of cards). */
  as?: 'h2' | 'h3';
}) {
  return (
    <As className={cn('text-old-h2 font-semibold text-[var(--c-fg)]', className)}>{children}</As>
  );
}

export function CardMeta({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <p className={cn('text-old-body-sm text-[var(--c-fg-muted)]', className)}>{children}</p>
  );
}

/**
 * Card body — the canonical padded content region. Exists so consumers
 * STOP hand-rolling `px-4 py-3` (which is why py-2 / py-2.5 / py-3 card
 * bodies coexisted across the app). Compose Card > CardHeader? >
 * CardBody and never type body padding again.
 */
export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('px-[var(--card-pad)] py-3', className)}>{children}</div>
  );
}
