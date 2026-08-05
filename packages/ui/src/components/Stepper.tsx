import type { ReactNode } from 'react';
import { cn } from '../cn';

interface Step {
  key: string;
  label: ReactNode;
}

interface StepperProps {
  steps: Step[];
  currentIndex: number;
  className?: string;
}

export function Stepper({ steps, currentIndex, className }: StepperProps) {
  return (
    <ol className={cn('flex items-center gap-2', className)} role="list">
      {steps.map((s, i) => {
        const done = i < currentIndex;
        const active = i === currentIndex;
        return (
          <li key={s.key} className="flex flex-1 items-center gap-2 last:flex-none">
            <div
              // Dense tier (28px) circle; the pending state wears the
              // translucent capsule fill instead of a hairline, like
              // every other quiet control (capsule pass).
              className={cn(
                'flex h-[var(--control-h-xs)] w-[var(--control-h-xs)] items-center justify-center rounded-full text-label font-semibold',
                done && 'bg-[var(--c-success)] text-[var(--c-fg-inverse)]',
                active && 'bg-[var(--c-action)] text-[var(--c-action-fg)] ring-2 ring-[var(--c-action)] ring-offset-2 ring-offset-[var(--c-bg)]',
                !done && !active && 'bg-[var(--c-capsule)] text-[var(--c-fg-muted)]',
              )}
              aria-current={active ? 'step' : undefined}
            >
              {done ? <span aria-hidden>✓</span> : i + 1}
            </div>
            <span className={cn('text-body-sm', active ? 'font-semibold text-[var(--c-fg)]' : 'text-[var(--c-fg-muted)]')}>
              {s.label}
            </span>
            {i < steps.length - 1 ? (
              <span className="mx-1 h-px flex-1 bg-[var(--c-divider)]" aria-hidden />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
