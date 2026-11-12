import type { ReactNode } from 'react';
import { cn } from '../cn';

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  /**
   * A sentence instead of a heading, for "nothing matches" inside a list,
   * a card or a sheet (review UI-13, 2026-11-11). The full state's h2
   * was too heavy there, so pages wrote their own muted line, each with
   * its own padding.
   */
  compact?: boolean;
}

export function EmptyState({ title, description, action, className, compact }: EmptyStateProps) {
  if (compact) {
    return (
      <div className={cn('flex flex-col items-center gap-2 px-4 py-6 text-center', className)}>
        {/* A lone line is a quiet note; over a description it leads. */}
        <p
          className={cn(
            'text-old-body',
            description ? 'font-medium text-[var(--c-fg)]' : 'text-[var(--c-fg-muted)]',
          )}
        >
          {title}
        </p>
        {description ? (
          <p className="max-w-sm text-old-body-sm text-[var(--c-fg-muted)]">{description}</p>
        ) : null}
        {action ? <div>{action}</div> : null}
      </div>
    );
  }
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-12 text-center',
        className,
      )}
    >
      {/* h2 (A11Y-10, 2026-10-31): an empty state is the page's content
          under its <h1>; as h3 it skipped a heading level. */}
      <h2 className="text-old-h2 font-semibold text-[var(--c-fg)]">{title}</h2>
      {description ? (
        <p className="max-w-sm text-old-body text-[var(--c-fg-muted)]">{description}</p>
      ) : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
