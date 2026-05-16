import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../cn';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
  as?: 'div' | 'section' | 'article';
}

export function Card({ className, interactive, as: As = 'div', ...rest }: CardProps) {
  return (
    <As
      className={cn(
        'rounded-[var(--r-card)] bg-[var(--c-surface)] ring-hairline',
        interactive && 'press cursor-pointer',
        className,
      )}
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
    <h3 className={cn('text-h2 font-semibold tracking-tight text-[var(--c-fg)]', className)}>
      {children}
    </h3>
  );
}

export function CardMeta({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <p className={cn('text-body-sm text-[var(--c-fg-muted)]', className)}>{children}</p>
  );
}
