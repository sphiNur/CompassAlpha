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
    <header
      className={cn(
        'flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-[var(--app-inline-x)] pb-2 pt-2',
        className,
      )}
    >
      <div className="min-w-0 flex-1 basis-[14rem]">
        <h1 className="truncate text-h1 font-semibold leading-[1.15] text-[var(--c-fg)]">
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-0.5 truncate text-body-sm text-[var(--c-fg-muted)]">
            {subtitle}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex max-w-full shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
