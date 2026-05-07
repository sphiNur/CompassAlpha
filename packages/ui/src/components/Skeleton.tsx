import { cn } from '../cn';

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={cn(
        'animate-pulse rounded-[var(--r-utility)] bg-[var(--c-surface-2)]',
        className,
      )}
      aria-hidden
    />
  );
}
