import type { ReactNode } from 'react';
import { cn } from '../cn';

interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 px-6 py-12 text-center', className)}>
      {icon ? <div className="text-[var(--c-fg-subtle)] text-3xl">{icon}</div> : null}
      {/* h2 (A11Y-10, 2026-10-31): an empty state is the page's content
          under its <h1>; as h3 it skipped a heading level. */}
      <h2 className="text-old-h1 font-semibold text-[var(--c-fg)]">{title}</h2>
      {description ? (
        <p className="max-w-sm text-old-body text-[var(--c-fg-muted)]">{description}</p>
      ) : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
