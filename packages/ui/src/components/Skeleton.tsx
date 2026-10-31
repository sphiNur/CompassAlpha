import { cn } from '../cn';

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={cn(
        // A11Y-8 (2026-10-31): no pulsing for "reduce motion".
        'animate-pulse motion-reduce:animate-none rounded-[var(--r-utility)] bg-[var(--c-surface-2)]',
        className,
      )}
      aria-hidden
    />
  );
}
