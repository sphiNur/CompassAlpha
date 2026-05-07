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
    <header className={cn('flex items-start justify-between gap-3 px-4 pt-4', className)}>
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
