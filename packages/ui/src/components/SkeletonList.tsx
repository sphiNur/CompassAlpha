import { cn } from '../cn';
import { rowGroupClass, surfaceClass } from './Card';
import { LoadingState } from './LoadingState';
import { Skeleton } from './Skeleton';

export interface SkeletonListProps {
  /** How many placeholder rows or cards. */
  count?: number;
  /** `rows`: one row group (a list of lines); `cards`: separate cards. */
  variant?: 'rows' | 'cards';
  /** Overrides the "Loading" said to screen readers. */
  label?: string;
  className?: string;
}

/**
 * The shape of a list while it loads (UI overhaul B, 2026-11-15): grey
 * lines where the rows will be, so the page does not jump when they
 * arrive. It fades in after a beat, so a fast load shows nothing. Screen
 * readers hear "Loading", as from LoadingState.
 */
export function SkeletonList({ count = 4, variant = 'rows', label, className }: SkeletonListProps) {
  const lines = Array.from({ length: count }, (_, i) => (
    <div key={i} className="flex flex-col gap-2 px-4 py-3">
      <Skeleton className={cn('h-4', i % 2 ? 'w-1/2' : 'w-3/5')} />
      <Skeleton className={cn('h-3', i % 2 ? 'w-1/3' : 'w-2/5')} />
    </div>
  ));
  return (
    <div className={cn('skeleton-delay', className)}>
      <LoadingState variant="inline" label={label} className="sr-only" />
      {variant === 'rows' ? (
        <div className={rowGroupClass} aria-hidden>
          {lines}
        </div>
      ) : (
        <div className="flex flex-col gap-2" aria-hidden>
          {lines.map((line, i) => (
            <div key={i} className={surfaceClass}>
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
