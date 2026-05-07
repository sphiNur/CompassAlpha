import type { ReactNode } from 'react';
import { cn } from '../cn';

export interface PageHeaderProps {
  title: ReactNode;
  /** Small caption below the title. */
  subtitle?: ReactNode;
  /** Right-side content — e.g. a primary action button or a count badge. */
  actions?: ReactNode;
  className?: string;
}

/**
 * Standardized page-title strip. Replaces the per-page inline `<header>`
 * blocks that drifted in font size + spacing across OrderPage / RunPage
 * / ApprovalPage / ConfirmPage / AdminPage. Title 22px semibold, subtitle
 * 13px muted — same visual weight everywhere.
 */
export function PageHeader({ title, subtitle, actions, className }: PageHeaderProps) {
  return (
    <header className={cn('flex items-end justify-between gap-3 px-4 pb-2 pt-2', className)}>
      <div className="min-w-0">
        <h1 className="truncate text-h1 font-semibold leading-[1.15] tracking-tight text-[var(--c-fg)]">
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-0.5 truncate text-body-sm text-[var(--c-fg-muted)]">
            {subtitle}
          </p>
        ) : null}
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </header>
  );
}
