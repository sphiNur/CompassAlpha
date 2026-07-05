import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../cn';

/**
 * The one definition of the Concord "card surface": rounded-card +
 * surface fill + hairline ring. Compose this everywhere a card/row/tile
 * needs the surface look instead of re-typing the trio (it was
 * independently re-declared in Card, SectionRow, ListRow and Tile —
 * five owners guaranteed drift on any tweak). Change the surface once,
 * here. See FRONTEND_AUDIT_2026-07.md.
 */
export const surfaceClass = 'rounded-[var(--r-card)] bg-[var(--c-surface)] ring-hairline';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
  as?: 'div' | 'section' | 'article';
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

export function CardTitle({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <h3 className={cn('text-h2 font-semibold text-[var(--c-fg)]', className)}>
      {children}
    </h3>
  );
}

export function CardMeta({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <p className={cn('text-body-sm text-[var(--c-fg-muted)]', className)}>{children}</p>
  );
}

/**
 * Card body — the canonical padded content region. Exists so consumers
 * STOP hand-rolling `px-4 py-3` (which is why py-2 / py-2.5 / py-3 card
 * bodies coexisted across the app). Compose Card > CardHeader? >
 * CardBody > CardFooter? and never type body padding again.
 */
export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('px-[var(--card-pad)] py-3', className)}>{children}</div>
  );
}

/**
 * Card footer — the bordered action strip at the bottom of a card
 * (Edit / Archive rows in the admin catalog, etc.). One definition of
 * the `border-t divider` + gutter so the strip stops drifting between
 * px-4 py-2 and px-3 py-2 per call site.
 */
export function CardFooter({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 border-t border-[var(--c-divider)] px-[var(--card-pad)] py-2',
        className,
      )}
    >
      {children}
    </div>
  );
}
