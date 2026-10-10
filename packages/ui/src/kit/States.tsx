import type { ReactNode } from 'react';
import { cn } from '../cn';
import { Button } from './Button';

export interface EmptyStateProps {
  /** What is not here, in the person's terms: "No orders waiting". */
  title: string;
  /** Why, or what will make something appear. */
  hint?: string;
  /**
   * The next step: a Button that takes the person somewhere useful. Pass
   * `null` only when there is truly nothing they can do from here; the
   * prop is required so that is a decision and not an omission.
   */
  action: ReactNode;
  className?: string;
}

export function EmptyState({ title, hint, action, className }: EmptyStateProps) {
  return (
    <div data-state="empty" className={cn('flex flex-col gap-sm', className)}>
      <p className="text-h2 text-ink">{title}</p>
      {hint ? <p className="text-body text-secondary">{hint}</p> : null}
      {action ? <div className="pt-sm">{action}</div> : null}
    </div>
  );
}

export interface ErrorStateProps {
  /** What failed, in the person's terms: "Couldn't load today's orders". */
  title: string;
  /** The reason, when there is one worth reading. */
  detail?: string;
  retryLabel: string;
  onRetry: () => void;
  retrying?: boolean;
  className?: string;
}

/** A failure always comes with a way to try again. */
export function ErrorState({
  title,
  detail,
  retryLabel,
  onRetry,
  retrying,
  className,
}: ErrorStateProps) {
  return (
    <div role="alert" data-state="error" className={cn('flex flex-col gap-sm', className)}>
      <p className="text-h2 text-ink">{title}</p>
      {detail ? <p className="break-words text-body text-secondary">{detail}</p> : null}
      <div className="pt-sm">
        <Button variant="secondary" onClick={onRetry} busy={retrying}>
          {retryLabel}
        </Button>
      </div>
    </div>
  );
}
