import type { HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../cn';

const badge = cva(
  'inline-flex items-center gap-1 rounded-[var(--r-pill)] px-2.5 py-0.5 text-old-label font-medium',
  {
    variants: {
      tone: {
        info: 'bg-[var(--c-surface-2)] text-[var(--c-fg-muted)] ring-hairline',
        success: 'bg-[var(--c-success-bg)] text-[var(--c-success-ink)]',
        warn: 'bg-[var(--c-warn-bg)] text-[var(--c-warn-ink)]',
        danger: 'bg-[var(--c-danger-bg)] text-[var(--c-danger-ink)]',
        action: 'bg-[var(--c-action)] text-[var(--c-action-fg)]',
        muted: 'bg-transparent text-[var(--c-fg-subtle)] ring-hairline',
      },
    },
    defaultVariants: { tone: 'info' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badge> {
  status?: string;
}

const STATUS_TO_TONE: Record<string, BadgeProps['tone']> = {
  draft: 'muted',
  submitted: 'info',
  approved: 'success',
  rejected: 'danger',
  in_run: 'action',
  archived: 'muted',
  planned: 'info',
  purchasing: 'action',
  delivering: 'action',
  finished: 'success',
  cancelled: 'danger',
};

export function Badge({ className, tone, status, children, ...rest }: BadgeProps) {
  const resolvedTone: BadgeProps['tone'] =
    tone ?? (status ? STATUS_TO_TONE[status] ?? 'info' : 'info');
  return (
    <span className={cn(badge({ tone: resolvedTone }), className)} {...rest}>
      {children ?? status}
    </span>
  );
}
